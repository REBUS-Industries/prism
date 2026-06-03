using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRISM.Agent.Config;
using PRISM.Agent.Pipeline;
using PRISM.Agent.Ws;
using PRISM.Contracts;

namespace PRISM.Agent;

/// <summary>
/// Main hosted service. Wires the WS client, sends <c>hello</c> on
/// connect, runs the heartbeat loop, and surfaces dispatcher acks.
/// </summary>
public sealed class AgentService : BackgroundService
{
    readonly ILogger<AgentService> _log;
    readonly AgentConfig _cfg;
    readonly WsClient _ws;
    readonly AgentMessageDispatcher _dispatcher;
    readonly WorkerSlotPool _slots;

    // Signature of the installed-version fields last announced to the server in
    // a `hello`. The heartbeat loop re-resolves these every tick and re-sends
    // `hello` when they change, so the admin Workstations row converges on the
    // true installed UE template / connector version even when the change
    // happened out-of-band (a pull that did not go through the control plane,
    // a manual template swap, etc.) and no reconnect has occurred. Without this
    // the server only learns the versions at connect time + after a control-
    // plane pull/mutation.
    string _lastReportedVersionSig = "";

    public AgentService(
        ILogger<AgentService> log,
        AgentConfig cfg,
        WsClient ws,
        AgentMessageDispatcher dispatcher,
        WorkerSlotPool slots)
    {
        _log = log;
        _cfg = cfg;
        _ws = ws;
        _dispatcher = dispatcher;
        _slots = slots;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _log.LogInformation("PRISM.Agent starting: node={NodeName} machineId={MachineId} slots={Slots} prismUrl={Url}",
            _cfg.NodeName, _cfg.MachineId, _cfg.Slots, _cfg.PrismUrl);

        // If the previous run attempted an in-app update and the script
        // logged a failure, surface that prominently so the operator
        // doesn't think "Check for updates" was a no-op.
        var lastFailure = Tray.Updater.GetLastUpdateFailure();
        if (lastFailure is not null)
        {
            _log.LogError(
                "Previous in-app update attempt failed. Diagnostic log:\n{Log}",
                lastFailure);
        }

        // Visualiser role pre-flight: if Visualiser is enabled but UE is
        // not where the operator said it would be, warn loudly. The agent
        // keeps running so other roles still work — Phase G's dispatcher
        // only routes runs to agents whose `canVisualise` is on, so a
        // misconfigured box will just sit idle until either the admin
        // turns the role off or the operator installs UE.
        if (_cfg.Roles.Contains(AgentRole.Visualiser))
        {
            var ueRoot = _cfg.UnrealEngineRoot ?? string.Empty;
            if (string.IsNullOrWhiteSpace(ueRoot) || !Directory.Exists(ueRoot))
            {
                _log.LogWarning(
                    "Visualiser role enabled but UE root not found: {UnrealEngineRoot}",
                    ueRoot);
            }
            else
            {
                _log.LogInformation("Visualiser role enabled; UE root {UnrealEngineRoot} found", ueRoot);
            }
        }

        _ws.OnReconnected += SendHelloFireAndForget;
        await _ws.StartAsync(stoppingToken);
        SendHelloFireAndForget();

        // Heartbeat loop
        var hb = TimeSpan.FromSeconds(15);
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(hb, stoppingToken); }
            catch (TaskCanceledException) { break; }

            try
            {
                await _ws.SendAsync(MessageType.Heartbeat, new HeartbeatData
                {
                    SlotsBusy = _slots.BusyCount,
                });

                // If the installed UE template / connector version (or the
                // agent version) changed since our last `hello`, re-announce so
                // the server's workstation row stays in sync with what the
                // agent's local web UI shows. Cheap: TemplateMarker.Resolve is a
                // single small-file read, gated by a string-equality check so
                // we only emit a hello on actual change.
                if (_ws.IsConnected)
                    ReportVersionsIfChanged();
            }
            catch (Exception err)
            {
                _log.LogWarning(err, "heartbeat send failed");
            }
        }

        _log.LogInformation("PRISM.Agent stopping");
    }

    void SendHelloFireAndForget()
    {
        var (templateTag, connectorTag) = Visualiser.TemplateMarker.Resolve(_cfg);
        var agentVersion = typeof(AgentService).Assembly.GetName().Version?.ToString() ?? "0.1.0";
        var hello = new HelloData
        {
            MachineId = _cfg.MachineId,
            NodeName = _cfg.NodeName,
            Slots = _cfg.Slots,
            Formats = SupportedFormats,
            Roles = _cfg.Roles,
            AgentVersion = agentVersion,
            RhinoVersion = null,  // Phase 3: read from Rhino.Inside host
            // Which orbit-ue-template release is installed at the configured
            // VisualiserTemplateProjectPath (durable marker, config fallback).
            InstalledTemplateTag = templateTag,
            InstalledConnectorTag = connectorTag,
        };
        _lastReportedVersionSig = VersionSig(agentVersion, templateTag, connectorTag);
        _ = _ws.SendAsync(MessageType.Hello, hello);
    }

    /// <summary>
    /// Re-send <c>hello</c> when the resolved installed-version fields have
    /// changed since the last announcement. Called on every heartbeat tick so
    /// an out-of-band version change (template re-pull, manual swap) reaches
    /// the admin Workstations page within one heartbeat interval, without
    /// waiting for a reconnect or a control-plane mutation.
    /// </summary>
    void ReportVersionsIfChanged()
    {
        var (templateTag, connectorTag) = Visualiser.TemplateMarker.Resolve(_cfg);
        var agentVersion = typeof(AgentService).Assembly.GetName().Version?.ToString() ?? "0.1.0";
        var sig = VersionSig(agentVersion, templateTag, connectorTag);
        if (sig == _lastReportedVersionSig) return;

        _log.LogInformation(
            "installed versions changed since last hello (agent={Agent} template={Template} connector={Connector}); re-announcing",
            agentVersion, templateTag ?? "<none>", connectorTag ?? "<none>");
        SendHelloFireAndForget();
    }

    static string VersionSig(string agentVersion, string? templateTag, string? connectorTag) =>
        $"{agentVersion}\u0001{templateTag ?? ""}\u0001{connectorTag ?? ""}";

    internal static readonly string[] SupportedFormats =
    {
        // Phase 2 scaffold reports what Rhino *can* handle once Phase 3
        // wires up the importers. The orchestrator uses this list to
        // route jobs. `.zip` is the bundle ingestion format — the agent
        // extracts it via ZipBundleExtractor and hands the primary
        // geometry file to RhinoFileOpener at job runtime.
        ".3dm", ".dwg", ".dxf", ".fbx", ".obj", ".stl", ".ply",
        ".3mf", ".dae", ".step", ".stp", ".iges", ".igs", ".zip",
    };
}
