using Microsoft.Extensions.Logging;
using PRISM.Agent.Config;
using PRISM.Agent.Pipeline;
using PRISM.Agent.Ws;
using PRISM.Contracts;

namespace PRISM.Agent;

/// <summary>
/// Live, mutable agent state shared between the tray UI and the web UI.
///
/// Every consumer that wants to "change a setting" or "pause the watcher"
/// goes through this object instead of poking <see cref="AgentConfig"/> /
/// <see cref="WsClient"/> directly, so the two surfaces stay in sync and
/// re-emitting <see cref="MessageType.Hello"/> after a mutation lives in
/// exactly one place.
/// </summary>
public sealed class AgentControlPlane
{
    readonly ILogger<AgentControlPlane> _log;
    readonly AgentConfig _cfg;
    readonly WsClient _ws;
    readonly WorkerSlotPool _slots;

    bool _paused;

    public AgentControlPlane(
        ILogger<AgentControlPlane> log,
        AgentConfig cfg,
        WsClient ws,
        WorkerSlotPool slots)
    {
        _log = log;
        _cfg = cfg;
        _ws = ws;
        _slots = slots;
    }

    // ---- Read-only views ------------------------------------------------

    public AgentConfig Config => _cfg;

    public bool IsPaused => _paused;
    public bool IsConnected => _ws.IsConnected;

    public int SlotsBusy => _slots.BusyCount;
    public int SlotsTotal => _cfg.Slots;

    public string AgentVersion =>
        typeof(AgentControlPlane).Assembly.GetName().Version?.ToString() ?? "0.0.0";

    public IReadOnlyCollection<string> SupportedFormats => AgentService.SupportedFormats;

    /// <summary>Raised whenever a mutation runs.  Tray + web UI subscribe.</summary>
    public event Action? StateChanged;

    void Notify()
    {
        try { StateChanged?.Invoke(); }
        catch (Exception ex) { _log.LogWarning(ex, "control-plane subscriber threw"); }
    }

    // ---- Watcher pause / resume ----------------------------------------

    public async Task PauseAsync()
    {
        if (_paused) return;
        _paused = true;
        try { await _ws.PauseAsync(); }
        catch (Exception ex) { _log.LogWarning(ex, "ws pause threw"); }
        _log.LogInformation("watcher paused");
        Notify();
    }

    public void Resume()
    {
        if (!_paused) return;
        _paused = false;
        try { _ws.Resume(); }
        catch (Exception ex) { _log.LogWarning(ex, "ws resume threw"); }
        _log.LogInformation("watcher resumed");
        Notify();
    }

    // ---- Setting mutations ---------------------------------------------

    public async Task SetSlotsAsync(int slots)
    {
        var clamped = Math.Max(1, Math.Min(8, slots));
        if (clamped == _cfg.Slots) return;
        _cfg.Slots = clamped;
        _cfg.Save();
        _log.LogInformation("slots changed -> {Slots}", clamped);
        await SendHelloAsync();
        Notify();
    }

    public async Task SetRolesAsync(AgentRole[] roles)
    {
        var deduped = roles.Distinct().ToArray();
        if (deduped.SequenceEqual(_cfg.Roles)) return;
        _cfg.Roles = deduped;
        _cfg.Save();
        _log.LogInformation("roles changed -> {Roles}", string.Join(",", deduped));
        await SendHelloAsync();
        Notify();
    }

    public async Task SetNodeNameAsync(string nodeName)
    {
        if (string.IsNullOrWhiteSpace(nodeName)) return;
        if (nodeName == _cfg.NodeName) return;
        _cfg.NodeName = nodeName.Trim();
        _cfg.Save();
        _log.LogInformation("nodeName changed -> {NodeName}", _cfg.NodeName);
        await SendHelloAsync();
        Notify();
    }

    /// <summary>
    /// Apply an arbitrary subset of settings in one shot.  Returns
    /// <c>RestartRequired = true</c> when a field changed that the running
    /// agent cannot pick up live (PrismUrl, RhinoVersion, WebUiPort,
    /// WebUiBindAll).
    /// </summary>
    public async Task<ConfigUpdateResult> ApplyAsync(ConfigUpdate update)
    {
        bool restart = false;

        if (update.PrismUrl is { } u && u != _cfg.PrismUrl)
        {
            _cfg.PrismUrl = u;
            restart = true;
        }
        if (update.RhinoVersion is { } rv && rv != _cfg.RhinoVersion)
        {
            _cfg.RhinoVersion = rv;
            restart = true;
        }
        if (update.WebUiPort is { } port && port != _cfg.WebUiPort)
        {
            _cfg.WebUiPort = port;
            restart = true;
        }
        if (update.WebUiBindAll is { } bindAll && bindAll != _cfg.WebUiBindAll)
        {
            _cfg.WebUiBindAll = bindAll;
            restart = true;
        }

        if (update.NodeName is { } name && !string.IsNullOrWhiteSpace(name))
            _cfg.NodeName = name.Trim();

        if (update.Slots is { } slots)
            _cfg.Slots = Math.Max(1, Math.Min(8, slots));

        if (update.Roles is { } roles)
            _cfg.Roles = roles.Distinct().ToArray();

        if (update.LogDir is { } ld && !string.IsNullOrWhiteSpace(ld))
            _cfg.LogDir = ld.Trim();

        _cfg.Save();
        _log.LogInformation("config saved (restartRequired={Restart})", restart);

        if (!restart)
            await SendHelloAsync();

        Notify();
        return new ConfigUpdateResult(restart, _cfg);
    }

    public Task SendHelloAsync()
    {
        return _ws.SendAsync(MessageType.Hello, new HelloData
        {
            MachineId    = _cfg.MachineId,
            NodeName     = _cfg.NodeName,
            Slots        = _cfg.Slots,
            Roles        = _cfg.Roles,
            Formats      = AgentService.SupportedFormats,
            AgentVersion = AgentVersion,
            RhinoVersion = null,
        }).AsTask();
    }
}

/// <summary>
/// Whitelisted partial update payload accepted by
/// <see cref="AgentControlPlane.ApplyAsync"/>.  Everything is nullable so
/// the web UI can PATCH single fields.
/// </summary>
public sealed class ConfigUpdate
{
    public string?      PrismUrl     { get; set; }
    public string?      NodeName     { get; set; }
    public int?         Slots        { get; set; }
    public AgentRole[]? Roles        { get; set; }
    public string?      RhinoVersion { get; set; }
    public string?      LogDir       { get; set; }
    public int?         WebUiPort    { get; set; }
    public bool?        WebUiBindAll { get; set; }
}

public sealed record ConfigUpdateResult(bool RestartRequired, AgentConfig Config);
