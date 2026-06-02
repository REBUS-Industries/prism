using System.Diagnostics;
using System.Text;
using Microsoft.Extensions.Logging;
using PRISM.Agent.Config;
using PRISM.Agent.Pipeline;
using PRISM.Agent.Tray;
using PRISM.Agent.Visualiser;
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

    // Single-flight gate + last-known status for the "pull latest UE
    // template" action. Both the local web UI and the admin Workstations
    // page (via the WS `pullTemplate` command) funnel through PullTemplateAsync,
    // so the gate stops a second trigger from racing the first on the same
    // template directory. The status is surfaced on the web UI's /api/state
    // so an operator can watch progress without tailing logs.
    readonly SemaphoreSlim _templatePullGate = new(1, 1);
    volatile TemplatePullStatus _templatePull = TemplatePullStatus.Idle();

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

    /// <summary>Last-known state of the "pull latest UE template" action.</summary>
    public TemplatePullStatus TemplatePull => _templatePull;

    /// <summary>True while a template pull is running.</summary>
    public bool IsTemplatePullInProgress => _templatePullGate.CurrentCount == 0;

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

    /// <summary>
    /// Toggle the Visualiser debug-window setting (visible UE window on the
    /// next run). Live-applied — the orchestrator reads it at job launch, so
    /// no agent restart is required. Mirrors <see cref="SetRolesAsync"/>'s
    /// persist-then-notify shape so the tray + web UI stay in sync.
    /// </summary>
    public async Task SetVisualiserDebugWindowAsync(bool enabled)
    {
        if (enabled == _cfg.VisualiserDebugWindow) return;
        _cfg.VisualiserDebugWindow = enabled;
        _cfg.Save();
        _log.LogInformation("visualiser debug window changed -> {Enabled}", enabled);
        await SendHelloAsync();
        Notify();
    }

    /// <summary>
    /// Toggle the Visualiser full-editor setting (open the full Unreal
    /// Editor GUI on the next run for inspection — SUPERSEDES the
    /// debug-window setting). Live-applied — the orchestrator reads it at
    /// job launch, so no agent restart is required. Mirrors
    /// <see cref="SetVisualiserDebugWindowAsync"/>'s persist-then-notify
    /// shape so the tray + web UI stay in sync.
    /// </summary>
    public async Task SetVisualiserFullEditorAsync(bool enabled)
    {
        if (enabled == _cfg.VisualiserFullEditor) return;
        _cfg.VisualiserFullEditor = enabled;
        _cfg.Save();
        _log.LogInformation("visualiser full editor changed -> {Enabled}", enabled);
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

        // Visualiser settings (Phase A: live-applied, no restart required —
        // the orchestrator only reads them at the next startVisualisation).
        if (update.UnrealEngineRoot is { } uer && !string.IsNullOrWhiteSpace(uer))
            _cfg.UnrealEngineRoot = uer.Trim();
        if (update.UnrealTemplateTag is { } utt && !string.IsNullOrWhiteSpace(utt))
            _cfg.UnrealTemplateTag = utt.Trim();
        if (update.UnrealTemplateRepo is { } utr && !string.IsNullOrWhiteSpace(utr))
            _cfg.UnrealTemplateRepo = utr.Trim();
        if (update.VisualiserTemplateRoot is { } vtr && !string.IsNullOrWhiteSpace(vtr))
            _cfg.VisualiserTemplateRoot = vtr.Trim();
        if (update.OrbitConnectorRepo is { } ocr && !string.IsNullOrWhiteSpace(ocr))
            _cfg.OrbitConnectorRepo = ocr.Trim();
        // Connector tag: empty string is meaningful ("latest"), so apply verbatim when present.
        if (update.OrbitConnectorTag is { } oct)
            _cfg.OrbitConnectorTag = oct.Trim();
        if (update.VisualiserPullConnector is { } vpc)
            _cfg.VisualiserPullConnector = vpc;
        if (update.VisualiserCompileProject is { } vcp)
            _cfg.VisualiserCompileProject = vcp;
        if (update.VisualiserMaxConcurrent is { } vmc)
            _cfg.VisualiserMaxConcurrent = Math.Max(1, Math.Min(4, vmc));
        if (update.VisualiserGpuCheck is { } vgc)
            _cfg.VisualiserGpuCheck = vgc;
        if (update.VisualiserDebugWindow is { } vdw)
            _cfg.VisualiserDebugWindow = vdw;
        if (update.VisualiserFullEditor is { } vfe)
            _cfg.VisualiserFullEditor = vfe;
        // Template project path is read fresh at each visualiser job launch
        // (see VisualiserJob), so a change applies to the NEXT run with no
        // agent restart. Empty string resets to the configured default.
        if (update.VisualiserTemplateProjectPath is { } vtp)
            _cfg.VisualiserTemplateProjectPath = vtp.Trim();

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

    // ---- Remote management (restart / update) --------------------------

    /// <summary>
    /// Schedule a clean exit of the current agent process and a
    /// self-relaunch shortly afterwards.
    ///
    /// The Windows Scheduled Task installed by <c>install.ps1</c> already
    /// carries <c>RestartCount=3</c> / <c>RestartInterval=1m</c>, but
    /// that only fires on task FAILURE (non-zero exit). To handle clean
    /// admin-initiated restarts uniformly we spawn a tiny PowerShell
    /// helper that waits for our PID to exit and then relaunches the
    /// agent EXE — exactly the same pattern used by
    /// <see cref="Updater.DownloadAndInstallAsync"/>.
    /// </summary>
    public Task RestartAsync(string? reason = null)
    {
        _log.LogWarning("restart requested (reason={Reason})", reason ?? "<none>");

        var installDir = AppContext.BaseDirectory.TrimEnd('\\', '/');
        var exePath    = Path.Combine(installDir, "PRISM.Agent.exe");
        var pid        = Environment.ProcessId;
        var logPath    = Path.Combine(Path.GetTempPath(), "PRISM.Agent.Restart.log");

        var ps = $@"
$ErrorActionPreference = 'SilentlyContinue'
$log = '{Esc(logPath)}'
function W($m) {{ Add-Content -Path $log -Value (""[$([DateTime]::Now.ToString('HH:mm:ss'))] "" + $m) }}
W 'restart helper started for pid {pid}'
$proc = Get-Process -Id {pid} -ErrorAction SilentlyContinue
if ($proc) {{
    $null = $proc.WaitForExit(60000)
    W 'agent exited'
}} else {{
    W 'agent already exited'
}}
Start-Sleep -Milliseconds 500
if (Test-Path '{Esc(exePath)}') {{
    W 'launching new agent'
    Start-Process -FilePath '{Esc(exePath)}'
    W 'launched'
}} else {{
    W ""ERROR: exe not found at '{Esc(exePath)}'""
}}
";
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(ps));

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName        = "powershell.exe",
                Arguments       = $"-NoProfile -NonInteractive -EncodedCommand {encoded}",
                UseShellExecute = false,
                CreateNoWindow  = true,
            });
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "failed to schedule restart helper; exiting anyway and trusting Scheduled Task RestartCount");
        }

        // Give the WS pump a brief moment to flush any pending acks/logs,
        // then exit. We exit with a non-zero code so the Scheduled Task's
        // RestartCount also fires as a belt-and-braces fallback if the
        // PowerShell helper failed to launch.
        _ = Task.Run(async () =>
        {
            await Task.Delay(750);
            try { Environment.Exit(2); }
            catch { /* best effort */ }
        });

        return Task.CompletedTask;
    }

    public sealed record UpdateOutcome(
        bool    UpdateAvailable,
        string? Tag,
        bool    Downloading,
        string? Error,
        bool    AlreadyRunning = false);

    /// <summary>
    /// Wire the same code path as the tray menu's "Check for updates"
    /// into a programmatic call. If a newer release is available on
    /// GitHub Releases, kicks off
    /// <see cref="Updater.DownloadAndInstallAsync"/> in the background
    /// (it self-terminates the process when extraction is scheduled).
    /// Returns synchronously so the HTTP / WS caller can ack quickly.
    /// </summary>
    /// <remarks>
    /// v0.1.36: if a download is already in flight (local tray click
    /// raced a remote WS update or vice versa) the second caller gets
    /// <c>AlreadyRunning = true</c> and the in-flight attempt is left
    /// untouched. <see cref="Updater.IsUpdateInProgress"/> short-circuits
    /// before we even hit GitHub Releases so we don't waste a request.
    /// </remarks>
    public async Task<UpdateOutcome> CheckAndApplyUpdateAsync(string? pinnedTag = null)
    {
        _log.LogInformation("update requested (tag={Tag})", pinnedTag ?? "<latest>");

        if (Updater.IsUpdateInProgress)
        {
            _log.LogWarning(
                "update request ignored — another update is already in progress on this agent");
            return new UpdateOutcome(
                false, null, false,
                "Another update is already in progress on this agent.",
                AlreadyRunning: true);
        }

        Updater.UpdateInfo? info;
        try
        {
            info = await Updater.CheckForUpdateAsync();
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "update check failed");
            return new UpdateOutcome(false, null, false, ex.Message);
        }

        if (info is null)
        {
            _log.LogInformation("no update available (current={Version})", AgentVersion);
            return new UpdateOutcome(false, null, false, null);
        }

        // pinnedTag is honoured advisory-only: the GitHub release latest
        // is what Updater fetches today. If the operator pinned a tag
        // that does not match latest we still proceed with what's
        // available — admins generally want "give me whatever is on
        // GitHub now", not "match exact tag or fail".
        var captured = info;
        _ = Task.Run(async () =>
        {
            var prog = new Progress<int>(_ => { /* nop on the WS path */ });
            try
            {
                await Updater.DownloadAndInstallAsync(captured, prog);
            }
            catch (InvalidOperationException ex)
            {
                // Race: another caller grabbed _updateGate between our
                // IsUpdateInProgress probe above and the await inside
                // DownloadAndInstallAsync. Treat as benign, not an error.
                _log.LogWarning(
                    "update download skipped — already running ({Reason})",
                    ex.Message);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "update download/install failed");
            }
        });

        return new UpdateOutcome(true, captured.TagName, true, null);
    }

    // ---- Pull latest UE template ---------------------------------------

    public sealed record PullTemplateOutcome(
        bool    Started,
        string? Tag,
        bool    AlreadyRunning,
        string? Error);

    /// <summary>
    /// Kick off a background download + install of the latest (or pinned)
    /// <c>orbit-ue-template</c> release into
    /// <see cref="AgentConfig.VisualiserTemplateRoot"/>. Returns synchronously
    /// so the HTTP / WS caller can ack quickly; progress + the terminal result
    /// are tracked in <see cref="TemplatePull"/> (surfaced on the web UI) and
    /// the agent log. On success
    /// <see cref="AgentConfig.VisualiserTemplateProjectPath"/> is repointed at
    /// the freshly-pulled project so the next visualiser run uses it.
    /// </summary>
    /// <param name="pinnedTag">
    /// Optional release tag to pull; when null/empty the configured
    /// <see cref="AgentConfig.UnrealTemplateTag"/> is used, falling back to the
    /// repo's latest release if that is empty.
    /// </param>
    public PullTemplateOutcome PullTemplate(string? pinnedTag = null)
    {
        var tag = string.IsNullOrWhiteSpace(pinnedTag) ? null : pinnedTag.Trim();
        _log.LogInformation("template pull requested (tag={Tag})", tag ?? "<configured/latest>");

        if (!_templatePullGate.Wait(0))
        {
            _log.LogWarning("template pull ignored — another pull is already in progress on this agent");
            return new PullTemplateOutcome(false, tag, AlreadyRunning: true,
                Error: "Another template pull is already in progress on this agent.");
        }

        var startedTag = tag ?? (string.IsNullOrWhiteSpace(_cfg.UnrealTemplateTag) ? null : _cfg.UnrealTemplateTag.Trim());
        SetTemplatePull(TemplatePullStatus.Running(startedTag, "starting…"));

        _ = Task.Run(async () =>
        {
            try
            {
                var progress = new Progress<string>(msg =>
                    SetTemplatePull(_templatePull with { Message = msg, UpdatedAt = DateTime.UtcNow }));

                var result = await TemplatePuller.PullAsync(
                    repoSlug:       _cfg.UnrealTemplateRepo,
                    requestedTag:   tag,
                    configuredTag:  _cfg.UnrealTemplateTag,
                    templateRoot:   _cfg.VisualiserTemplateRoot,
                    connectorRepo:  _cfg.OrbitConnectorRepo,
                    connectorTag:   _cfg.OrbitConnectorTag,
                    pullConnector:  _cfg.VisualiserPullConnector,
                    compileProject: _cfg.VisualiserCompileProject,
                    engineRoot:     _cfg.UnrealEngineRoot,
                    progress:       progress,
                    log:            _log,
                    ct:             CancellationToken.None).ConfigureAwait(false);

                // Repoint the active template project at the freshly-pulled one
                // so the next visualiser run picks it up (read at job launch).
                _cfg.VisualiserTemplateProjectPath = result.ProjectPath;
                try { _cfg.Save(); }
                catch (Exception ex) { _log.LogWarning(ex, "template pull: failed to persist new template path"); }

                _log.LogInformation(
                    "template pull complete: {Project} tag={Tag} connector={Connector} -> {Path}",
                    result.ProjectName, result.Tag,
                    result.ConnectorTag ?? "<skipped>", result.ProjectPath);
                SetTemplatePull(TemplatePullStatus.Success(
                    result.Tag, result.ProjectName, result.ProjectPath, result.ConnectorTag));
                Notify();
            }
            catch (TemplatePullException ex)
            {
                _log.LogError(ex, "template pull failed");
                SetTemplatePull(TemplatePullStatus.Error(startedTag, ex.Message));
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "template pull failed (unexpected)");
                SetTemplatePull(TemplatePullStatus.Error(startedTag, ex.Message));
            }
            finally
            {
                _templatePullGate.Release();
            }
        });

        return new PullTemplateOutcome(true, startedTag, AlreadyRunning: false, Error: null);
    }

    void SetTemplatePull(TemplatePullStatus status)
    {
        _templatePull = status;
        Notify();
    }

    static string Esc(string path) => path.Replace("'", "''");
}

/// <summary>
/// Snapshot of the "pull latest UE template" action, surfaced on the agent
/// web UI so an operator can watch a pull without tailing logs.
/// </summary>
public sealed record TemplatePullStatus(
    string  State,            // idle | running | success | error
    string? Tag,
    string? Message,
    string? ProjectName,
    string? ProjectPath,
    string? ConnectorTag,
    DateTime? UpdatedAt)
{
    public static TemplatePullStatus Idle() =>
        new("idle", null, null, null, null, null, null);

    public static TemplatePullStatus Running(string? tag, string? message) =>
        new("running", tag, message, null, null, null, DateTime.UtcNow);

    public static TemplatePullStatus Success(string tag, string projectName, string projectPath, string? connectorTag) =>
        new("success", tag,
            connectorTag is { Length: > 0 }
                ? $"installed {projectName} ({tag}) + connector {connectorTag}"
                : $"installed {projectName} ({tag})",
            projectName, projectPath, connectorTag, DateTime.UtcNow);

    public static TemplatePullStatus Error(string? tag, string message) =>
        new("error", tag, message, null, null, null, DateTime.UtcNow);
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
    // Visualiser (Phase A — orchestrator binary lands in Phase F/G)
    public string?      UnrealEngineRoot        { get; set; }
    public string?      UnrealTemplateTag       { get; set; }
    public string?      UnrealTemplateRepo      { get; set; }
    public string?      VisualiserTemplateRoot  { get; set; }
    public string?      OrbitConnectorRepo      { get; set; }
    public string?      OrbitConnectorTag       { get; set; }
    public bool?        VisualiserPullConnector { get; set; }
    public bool?        VisualiserCompileProject { get; set; }
    public int?         VisualiserMaxConcurrent { get; set; }
    public bool?        VisualiserGpuCheck      { get; set; }
    public bool?        VisualiserDebugWindow   { get; set; }
    public bool?        VisualiserFullEditor    { get; set; }
    public string?      VisualiserTemplateProjectPath { get; set; }
}

public sealed record ConfigUpdateResult(bool RestartRequired, AgentConfig Config);
