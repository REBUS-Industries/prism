using System.Net.WebSockets;
using System.Text;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace PRISM.Agent.Visualiser;

/// <summary>
/// Per-runId bridge between the PRISM server (agent WS uplink) and the
/// orchestrator's local Cirrus Pixel Streaming signalling server.
///
/// Pipeline:
///   browser ⇄ PRISM server ⇄ agent WS ⇄ <see cref="SignallingBridge"/> ⇄
///     local Cirrus (ws://127.0.0.1:&lt;port&gt;/) ⇄ UE PixelStreaming streamer
///
/// PRISM does not parse the Pixel Streaming signalling sub-protocol.
/// <see cref="AgentMessageDispatcher"/> hands us each inbound
/// <c>SignallingFrame</c> envelope (text or base64-binary); we forward
/// it verbatim onto the local Cirrus socket. In the reverse direction
/// our pump task reads from the Cirrus socket and emits one
/// <c>SignallingFrame</c> envelope per inbound frame back upstream.
///
/// Lifetime:
///   - Created lazily by <see cref="SignallingBridgeRegistry"/> on the
///     first inbound frame for a runId (or eagerly when the orchestrator
///     publishes its <c>ready/v1</c> event).
///   - Disposed on visualisationEnded / visualisationFailed, on agent
///     shutdown, or when the local Cirrus socket closes from its end.
/// </summary>
public sealed class SignallingBridge : IDisposable
{
    public string RunId { get; }
    /// <summary>Per-viewer demux key — each viewer is an independent Wilbur player (1:1).</summary>
    public string ViewerId { get; }
    public Uri LocalCirrusUrl { get; }

    /// <summary>
    /// Authoritative single-controller gate. When false, browser→Cirrus
    /// frames recognised as Pixel Streaming input/command messages are
    /// dropped so a non-controller viewer cannot drive the viewport. Set
    /// by the server via <c>setViewerControl</c>. Defaults to true so a
    /// legacy server that doesn't manage control (or a single-viewer run)
    /// keeps full input — the per-viewer server always pushes the explicit
    /// state at connect, so multi-viewer runs gate correctly.
    ///
    /// NOTE: in this non-SFU topology Pixel Streaming input rides the
    /// peer-to-peer WebRTC data channel (browser↔UE via STUN/TURN), which
    /// does NOT traverse this bridge. This gate is therefore defence-in-
    /// depth for any input relayed over signalling; the behavioural
    /// enforcement for view-only is the server-driven client suppression
    /// (the client cannot enable input unless its JWT tier + the lock
    /// grant it). A hard guarantee against a modified client needs the UE
    /// template's <c>PixelStreaming2.InputController=Host</c> ownership —
    /// see INTEGRATION notes.
    /// </summary>
    public volatile bool AllowInput;

    readonly ILogger _log;
    readonly Func<string, string, ReadOnlyMemory<byte>?, string?, ValueTask> _sendUpstreamAsync;
    readonly CancellationTokenSource _cts;

    ClientWebSocket? _localWs;
    Task? _pumpTask;
    int _disposed;

    // Pixel Streaming client→streamer message `type` values that represent
    // INPUT / commands (not WebRTC negotiation). Dropped when !AllowInput.
    // SDP/ICE/keepalive/streamer-discovery types are deliberately absent so
    // video keeps flowing for every viewer.
    static readonly HashSet<string> InputMessageTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "emituiinteraction", "command",
        "keydown", "keyup", "keypress",
        "mousemove", "mousedown", "mouseup", "mousewheel", "mousedouble", "mouseenter", "mouseleave",
        "touchstart", "touchend", "touchmove",
        "gamepadbuttonpressed", "gamepadbuttonreleased", "gamepadanalog", "gamepadconnected", "gamepaddisconnected",
    };

    /// <summary>
    /// Construct a bridge. <paramref name="sendUpstreamAsync"/> is invoked
    /// for every Cirrus → server frame: (runId, viewerId, binary, text).
    /// Exactly one of binary/text is non-null per call (mirrors the wire
    /// shape in <c>SignallingFrameData</c>).
    /// </summary>
    public SignallingBridge(
        string runId,
        string viewerId,
        Uri localCirrusUrl,
        Func<string, string, ReadOnlyMemory<byte>?, string?, ValueTask> sendUpstreamAsync,
        ILogger log,
        bool allowInput = true)
    {
        RunId             = runId ?? throw new ArgumentNullException(nameof(runId));
        ViewerId          = viewerId ?? throw new ArgumentNullException(nameof(viewerId));
        LocalCirrusUrl    = localCirrusUrl ?? throw new ArgumentNullException(nameof(localCirrusUrl));
        _sendUpstreamAsync = sendUpstreamAsync ?? throw new ArgumentNullException(nameof(sendUpstreamAsync));
        _log               = log;
        AllowInput         = allowInput;
        _cts               = new CancellationTokenSource();
    }

    /// <summary>
    /// Establish the local Cirrus WS connection and start the reverse-
    /// channel pump. Idempotent; calling twice is a no-op after the
    /// first successful connect.
    /// </summary>
    public async Task StartAsync(CancellationToken externalCt)
    {
        if (_localWs is not null) return;
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(externalCt, _cts.Token);
        var ws = new ClientWebSocket();
        // Cirrus speaks the plain text+binary sub-protocol; no special
        // protocol negotiation required. Keep keep-alives modest so a
        // hung peer is noticed within ~30s.
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
        try
        {
            await ws.ConnectAsync(LocalCirrusUrl, linkedCts.Token).ConfigureAwait(false);
        }
        catch
        {
            ws.Dispose();
            throw;
        }
        _localWs = ws;
        _log.LogInformation("signalling bridge: connected to local Cirrus {Url} for runId={RunId} viewerId={ViewerId}", LocalCirrusUrl, RunId, ViewerId);
        _pumpTask = Task.Run(() => PumpLocalToServerAsync(_cts.Token));
    }

    /// <summary>
    /// Forward a server-&gt;agent frame onto the local Cirrus socket.
    /// Exactly one of <paramref name="text"/> / <paramref name="binary"/>
    /// must be non-null (mirrors the wire contract). No-op when the
    /// local socket is closed.
    /// </summary>
    public async ValueTask ForwardToLocalAsync(string? text, byte[]? binary, CancellationToken ct)
    {
        var ws = _localWs;
        if (ws is null || ws.State != WebSocketState.Open) return;

        // Control gate: when this viewer is not the controller, drop
        // browser→Cirrus input/command frames. WebRTC negotiation
        // (offer/answer/iceCandidate), streamer discovery, and keepalives
        // always pass so video keeps flowing.
        if (!AllowInput && !string.IsNullOrEmpty(text) && IsInputFrame(text))
        {
            _log.LogDebug("signalling bridge: dropped input frame from non-controller viewerId={ViewerId} runId={RunId}", ViewerId, RunId);
            return;
        }

        if (binary is not null && binary.Length > 0)
        {
            await ws.SendAsync(new ArraySegment<byte>(binary), WebSocketMessageType.Binary, endOfMessage: true, ct)
                    .ConfigureAwait(false);
        }
        else if (!string.IsNullOrEmpty(text))
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, endOfMessage: true, ct)
                    .ConfigureAwait(false);
        }
        // else: empty frame — silently drop. Cirrus doesn't use empty frames.
    }

    /// <summary>
    /// Shallow-parse a browser→Cirrus text frame and report whether it is
    /// a Pixel Streaming input/command message (vs WebRTC negotiation).
    /// Tolerant: a non-JSON or typeless frame is treated as non-input so
    /// we never accidentally block negotiation.
    /// </summary>
    static bool IsInputFrame(string text)
    {
        try
        {
            var obj = JToken.Parse(text) as JObject;
            var type = obj?.Value<string>("type");
            return type is not null && InputMessageTypes.Contains(type);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Pump Cirrus → server. Reassembles fragmented messages so a large
    /// SDP offer split across multiple WebSocket frames lands as one
    /// envelope upstream, then emits a single <c>signallingFrame</c>
    /// per logical message.
    /// </summary>
    async Task PumpLocalToServerAsync(CancellationToken ct)
    {
        var ws = _localWs!;
        var buffer = new byte[16 * 1024];
        using var ms = new MemoryStream();
        try
        {
            while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
            {
                ms.SetLength(0);
                WebSocketReceiveResult result;
                do
                {
                    result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        _log.LogInformation("signalling bridge: local Cirrus closed for runId={RunId} ({Status} {Reason})",
                            RunId, result.CloseStatus, result.CloseStatusDescription ?? "");
                        return;
                    }
                    ms.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                if (ms.Length == 0) continue;
                if (result.MessageType == WebSocketMessageType.Text)
                {
                    var text = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                    await _sendUpstreamAsync(RunId, ViewerId, null, text).ConfigureAwait(false);
                }
                else if (result.MessageType == WebSocketMessageType.Binary)
                {
                    // Copy into a right-sized array — the upstream
                    // sender base64-encodes and may outlive the
                    // MemoryStream buffer.
                    var bin = new byte[(int)ms.Length];
                    Buffer.BlockCopy(ms.GetBuffer(), 0, bin, 0, bin.Length);
                    await _sendUpstreamAsync(RunId, ViewerId, bin, null).ConfigureAwait(false);
                }
            }
        }
        catch (OperationCanceledException) { /* normal shutdown */ }
        catch (WebSocketException wsEx)
        {
            _log.LogWarning(wsEx, "signalling bridge: local Cirrus read failed for runId={RunId}", RunId);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "signalling bridge: unexpected pump failure for runId={RunId}", RunId);
        }
    }

    /// <summary>
    /// Indicates the local Cirrus socket is open. Tests use this to
    /// poll for connection establishment.
    /// </summary>
    public bool IsOpen => _localWs is { State: WebSocketState.Open };

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
        try { _cts.Cancel(); } catch { /* ignore */ }
        try
        {
            if (_localWs is { State: WebSocketState.Open })
            {
                // Best-effort close — give Cirrus a beat to acknowledge,
                // then dispose unconditionally so a slow peer can't hold
                // up agent teardown.
                _localWs.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bridge disposed", CancellationToken.None)
                        .GetAwaiter().GetResult();
            }
        }
        catch { /* ignore */ }
        try { _pumpTask?.Wait(TimeSpan.FromSeconds(2)); } catch { /* ignore */ }
        _localWs?.Dispose();
        _cts.Dispose();
    }
}
