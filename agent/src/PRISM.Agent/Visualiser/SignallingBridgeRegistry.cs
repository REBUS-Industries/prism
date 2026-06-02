using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using PRISM.Agent.Ws;
using PRISM.Contracts;

namespace PRISM.Agent.Visualiser;

/// <summary>
/// Owns the lifecycle of every active <see cref="SignallingBridge"/> on
/// this agent. One singleton per agent process.
///
/// Multi-viewer keying
/// -------------------
/// Bridges are keyed by <c>(runId, viewerId)</c>. Each browser viewer of a
/// run is an INDEPENDENT Pixel Streaming player with its own local
/// Cirrus/Wilbur player WS (1:1), so the streamer's per-player SDP/ICE
/// never collides between concurrent viewers — fixing the "second viewer
/// freezes the first" bug. Every viewer connects to the same per-run local
/// Cirrus URL (the Wilbur player port) registered via
/// <see cref="RegisterLocalCirrus"/>.
///
/// Control gate
/// ------------
/// The server pushes the authoritative single-controller lock per viewer
/// (<see cref="SetViewerControl"/>); the matching bridge gates input. The
/// last value is remembered in <see cref="_pendingControl"/> so a bridge
/// created after the control message still picks it up.
///
/// Disposal:
///   - <see cref="DropViewerAsync"/> — one viewer's tab closed.
///   - <see cref="DropAsync"/> — the whole run ended; drop every viewer.
///   - <see cref="DisposeAsync"/> — agent shutdown.
/// </summary>
public sealed class SignallingBridgeRegistry : IAsyncDisposable
{
    readonly ConcurrentDictionary<string, SignallingBridge> _bridges = new();       // key = runId|viewerId
    readonly ConcurrentDictionary<string, Uri> _knownLocalUrls = new();             // key = runId
    readonly ConcurrentDictionary<string, bool> _pendingControl = new();            // key = runId|viewerId
    readonly ILoggerFactory _loggerFactory;
    readonly ILogger<SignallingBridgeRegistry> _log;
    readonly WsClient _ws;

    /// <summary>Default Cirrus port for the lazy-instantiation fallback.
    /// Overridable via <c>PRISM_VISUALISER_CIRRUS_URL</c> env var so
    /// dev / CI can point at a different signaller. The Pixel
    /// Streaming reference Cirrus binds <c>:8888</c> by default.</summary>
    public static Uri DefaultLocalCirrusUrl =>
        new(Environment.GetEnvironmentVariable("PRISM_VISUALISER_CIRRUS_URL") ?? "ws://127.0.0.1:8888/");

    public SignallingBridgeRegistry(WsClient ws, ILoggerFactory loggerFactory)
    {
        _ws            = ws;
        _loggerFactory = loggerFactory;
        _log           = loggerFactory.CreateLogger<SignallingBridgeRegistry>();
    }

    static string Key(string runId, string viewerId) => $"{runId}|{viewerId}";

    /// <summary>
    /// Tell the registry which local Cirrus URL belongs to <paramref name="runId"/>.
    /// All viewers of the run connect to it (the Wilbur player port).
    /// </summary>
    public void RegisterLocalCirrus(string runId, Uri localCirrusUrl)
    {
        if (string.IsNullOrEmpty(runId)) throw new ArgumentException("runId is required", nameof(runId));
        ArgumentNullException.ThrowIfNull(localCirrusUrl);
        _knownLocalUrls[runId] = localCirrusUrl;
        _log.LogInformation("signalling bridge registry: registered local Cirrus URL {Url} for runId={RunId}", localCirrusUrl, runId);
    }

    /// <summary>
    /// Get the existing bridge for <c>(runId, viewerId)</c> or create &amp;
    /// connect a new one against the registered (or default) local Cirrus
    /// URL. Connection failures are logged + propagated so the caller can
    /// ack-reject the inbound envelope.
    /// </summary>
    public async Task<SignallingBridge> GetOrCreateAsync(string runId, string viewerId, CancellationToken ct = default)
    {
        var key = Key(runId, viewerId);
        if (_bridges.TryGetValue(key, out var existing) && existing.IsOpen)
            return existing;

        if (!_knownLocalUrls.TryGetValue(runId, out var url))
            url = DefaultLocalCirrusUrl;

        // Default-allow unless the server has already pushed a control
        // state for this viewer (multi-viewer runs always do at connect).
        var allowInput = !_pendingControl.TryGetValue(key, out var canControl) || canControl;

        var bridge = new SignallingBridge(
            runId,
            viewerId,
            url,
            SendUpstreamAsync,
            _loggerFactory.CreateLogger<SignallingBridge>(),
            allowInput);

        var added = _bridges.GetOrAdd(key, bridge);
        if (!ReferenceEquals(added, bridge))
        {
            bridge.Dispose();
            return added;
        }

        try
        {
            await bridge.StartAsync(ct).ConfigureAwait(false);
        }
        catch
        {
            _bridges.TryRemove(KeyValuePair.Create(key, bridge));
            bridge.Dispose();
            throw;
        }
        return bridge;
    }

    /// <summary>Look up an existing bridge without creating one.</summary>
    public SignallingBridge? TryGet(string runId, string viewerId)
        => _bridges.TryGetValue(Key(runId, viewerId), out var bridge) ? bridge : null;

    /// <summary>
    /// Apply the authoritative single-controller lock state for one viewer.
    /// Updates the live bridge if present and remembers the value so a
    /// bridge created later still picks it up.
    /// </summary>
    public void SetViewerControl(string runId, string viewerId, bool canControl)
    {
        var key = Key(runId, viewerId);
        _pendingControl[key] = canControl;
        if (_bridges.TryGetValue(key, out var bridge))
        {
            bridge.AllowInput = canControl;
        }
        _log.LogInformation("signalling bridge registry: viewer control runId={RunId} viewerId={ViewerId} canControl={CanControl}",
            runId, viewerId, canControl);
    }

    /// <summary>Tear down a single viewer's bridge (its browser tab closed).</summary>
    public Task DropViewerAsync(string runId, string viewerId)
    {
        var key = Key(runId, viewerId);
        _pendingControl.TryRemove(key, out _);
        if (_bridges.TryRemove(key, out var bridge))
        {
            bridge.Dispose();
            _log.LogInformation("signalling bridge registry: dropped viewer runId={RunId} viewerId={ViewerId}", runId, viewerId);
        }
        return Task.CompletedTask;
    }

    /// <summary>Tear down every bridge for a run (the run ended).</summary>
    public Task DropAsync(string runId)
    {
        _knownLocalUrls.TryRemove(runId, out _);
        var prefix = runId + "|";
        foreach (var key in _bridges.Keys)
        {
            if (!key.StartsWith(prefix, StringComparison.Ordinal)) continue;
            if (_bridges.TryRemove(key, out var bridge)) bridge.Dispose();
            _pendingControl.TryRemove(key, out _);
        }
        _log.LogInformation("signalling bridge registry: dropped all viewers for runId={RunId}", runId);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Cirrus → server upstream sender. Wraps the frame into a
    /// <c>signallingFrame</c> envelope (tagged with the viewer) and pushes
    /// it onto the agent WS outbox.
    /// </summary>
    async ValueTask SendUpstreamAsync(string runId, string viewerId, ReadOnlyMemory<byte>? binary, string? text)
    {
        var data = new SignallingFrameData { RunId = runId, ViewerId = viewerId };
        if (binary is { } b && b.Length > 0)
        {
            data.PayloadB64 = Convert.ToBase64String(b.Span);
        }
        else if (!string.IsNullOrEmpty(text))
        {
            data.Payload = text;
        }
        else
        {
            return;
        }
        try
        {
            await _ws.SendAsync(MessageType.SignallingFrame, data).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "signalling bridge registry: failed to push frame upstream for runId={RunId} viewerId={ViewerId}", runId, viewerId);
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var (_, bridge) in _bridges)
        {
            bridge.Dispose();
        }
        _bridges.Clear();
        _knownLocalUrls.Clear();
        _pendingControl.Clear();
        await Task.CompletedTask;
    }
}
