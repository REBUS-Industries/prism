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

    // Single-flight gate + last-known status for the "install engine plugin
    // from URL" action (mirrors the template-pull pattern). Surfaced on
    // /api/state so the web UI can watch progress.
    readonly SemaphoreSlim _enginePluginGate = new(1, 1);
    volatile EnginePluginInstallStatus _enginePluginInstall = EnginePluginInstallStatus.Idle();

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

    /// <summary>Last-known state of the "install engine plugin from URL" action.</summary>
    public EnginePluginInstallStatus EnginePluginInstall => _enginePluginInstall;

    /// <summary>True while an engine-plugin install is running.</summary>
    public bool IsEnginePluginInstallInProgress => _enginePluginGate.CurrentCount == 0;

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

        // Portal URL is NOT secret — applied verbatim (trimmed) when present.
        // Blank is allowed (resets toward whatever the operator typed); read at
        // job-launch, so a change applies on the NEXT visualiser run.
        if (update.PortalUrl is { } purl)
            _cfg.PortalUrl = purl.Trim();

        // Portal API key (SECRET) — update-or-keep semantics: a null OR
        // blank/whitespace value LEAVES THE STORED KEY UNCHANGED. The web UI
        // never receives the key back (it only knows rebusApiKeySet), so it
        // can't round-trip the value; treating blank as "no change" stops an
        // unrelated settings save from wiping the key. Only a non-blank value
        // replaces the stored key. (There is intentionally no clear-via-UI
        // path here; an operator clears it by editing agent-config.json.)
        if (!string.IsNullOrWhiteSpace(update.RebusApiKey))
            _cfg.RebusApiKey = update.RebusApiKey.Trim();

        // GitHub token (SECRET) — identical update-or-keep semantics as
        // RebusApiKey: a null OR blank/whitespace value LEAVES THE STORED TOKEN
        // UNCHANGED (the web UI only knows gitHubTokenSet and can't round-trip
        // the value), so an unrelated save never wipes it. Only a non-blank
        // value replaces it. Read at pull time, so it applies with no restart.
        if (!string.IsNullOrWhiteSpace(update.GitHubToken))
            _cfg.GitHubToken = update.GitHubToken.Trim();

        _cfg.Save();
        _log.LogInformation("config saved (restartRequired={Restart})", restart);

        if (!restart)
            await SendHelloAsync();

        Notify();
        return new ConfigUpdateResult(restart, _cfg);
    }

    public Task SendHelloAsync()
    {
        var (templateTag, connectorTag) = TemplateMarker.Resolve(_cfg);
        return _ws.SendAsync(MessageType.Hello, new HelloData
        {
            MachineId             = _cfg.MachineId,
            NodeName              = _cfg.NodeName,
            Slots                 = _cfg.Slots,
            Roles                 = _cfg.Roles,
            Formats               = AgentService.SupportedFormats,
            AgentVersion          = AgentVersion,
            RhinoVersion          = null,
            InstalledTemplateTag  = templateTag,
            InstalledConnectorTag = connectorTag,
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
        string? Error,
        // Set when the pull was NOT started because Unreal Engine is running
        // and the caller did not pass forceCloseUnreal. The web UI shows a
        // confirm prompt listing these and re-invokes the pull with force.
        bool    BlockedByUnreal = false,
        IReadOnlyList<Visualiser.UnrealProcessGuard.UnrealProc>? UnrealProcesses = null);

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
    /// <param name="pinnedTag">Optional release tag to pull (see remarks).</param>
    /// <param name="forceCloseUnreal">
    /// When false (default) and a running Unreal Engine instance is detected,
    /// the pull is NOT started — the returned outcome carries
    /// <see cref="PullTemplateOutcome.BlockedByUnreal"/> + the process list so
    /// the web UI can prompt the operator. When true the agent force-closes
    /// the detected Unreal processes (waiting for their handles to release)
    /// before pulling. The default is safe (never auto-kills without explicit
    /// confirmation).
    /// </param>
    /// <param name="connectorRef">
    /// Optional connector version ref override for this pull. When set, overrides
    /// <see cref="Config.AgentConfig.OrbitConnectorTag"/> for this pull only; the
    /// persisted config is not updated. Accepts a release tag (e.g. <c>v0.1.28</c>)
    /// or a branch ref prefixed with <c>branch:</c> (e.g.
    /// <c>branch:feat/import-progress-overlay</c>) to pull a branch source zipball.
    /// </param>
    public PullTemplateOutcome PullTemplate(string? pinnedTag = null, bool forceCloseUnreal = false,
        string? connectorRef = null)
    {
        var tag = string.IsNullOrWhiteSpace(pinnedTag) ? null : pinnedTag.Trim();
        var connRef = string.IsNullOrWhiteSpace(connectorRef) ? null : connectorRef.Trim();
        _log.LogInformation("template pull requested (tag={Tag} connectorRef={ConnRef} force={Force})",
            tag ?? "<configured/latest>", connRef ?? "<configured/latest>", forceCloseUnreal);

        if (!_templatePullGate.Wait(0))
        {
            _log.LogWarning("template pull ignored — another pull is already in progress on this agent");
            return new PullTemplateOutcome(false, tag, AlreadyRunning: true,
                Error: "Another template pull is already in progress on this agent.");
        }

        // Pre-flight: a running Unreal Editor locks the template folder and
        // makes the stage-and-swap fail with "Access to the path … is denied".
        // Unless the caller explicitly opted into force-close, refuse and hand
        // the process list back so the UI can confirm with the operator.
        var runningUnreal = Visualiser.UnrealProcessGuard.Detect(_log);
        if (runningUnreal.Count > 0 && !forceCloseUnreal)
        {
            _templatePullGate.Release();
            _log.LogWarning(
                "template pull blocked — Unreal Engine is running ({Procs}); operator confirmation required to force-close",
                Visualiser.UnrealProcessGuard.Describe(runningUnreal));
            return new PullTemplateOutcome(
                Started: false, Tag: tag, AlreadyRunning: false,
                Error: $"Unreal Engine is running ({runningUnreal.Count} instance(s)): " +
                       $"{Visualiser.UnrealProcessGuard.Describe(runningUnreal)}. " +
                       "Pulling a new template requires closing it. Confirm to force-close and continue.",
                BlockedByUnreal: true, UnrealProcesses: runningUnreal);
        }

        var startedTag = tag ?? (string.IsNullOrWhiteSpace(_cfg.UnrealTemplateTag) ? null : _cfg.UnrealTemplateTag.Trim());
        var willClose = runningUnreal.Count > 0;
        SetTemplatePull(TemplatePullStatus.Running(startedTag,
            willClose ? $"closing Unreal ({runningUnreal.Count} process(es))…" : "starting…"));

        _ = Task.Run(async () =>
        {
            try
            {
                var progress = new Progress<string>(msg =>
                    SetTemplatePull(_templatePull with { Message = msg, UpdatedAt = DateTime.UtcNow }));

                // Force-close any running Unreal instances first (operator
                // confirmed) and wait for their file handles to drop before the
                // pull touches the locked template folder.
                if (forceCloseUnreal)
                {
                    var killed = await Visualiser.UnrealProcessGuard
                        .ForceCloseAllAsync(progress, _log, CancellationToken.None)
                        .ConfigureAwait(false);
                    if (killed > 0)
                        _log.LogInformation("template pull: force-closed {Killed} Unreal process(es) before pull", killed);
                }

                var result = await TemplatePuller.PullAsync(
                    repoSlug:       _cfg.UnrealTemplateRepo,
                    requestedTag:   tag,
                    configuredTag:  _cfg.UnrealTemplateTag,
                    templateRoot:   _cfg.VisualiserTemplateRoot,
                    connectorRepo:  _cfg.OrbitConnectorRepo,
                    // connectorRef overrides the persisted config for this pull only.
                    connectorTag:   connRef ?? _cfg.OrbitConnectorTag,
                    pullConnector:  _cfg.VisualiserPullConnector,
                    compileProject: _cfg.VisualiserCompileProject,
                    engineRoot:     _cfg.UnrealEngineRoot,
                    gitHubToken:    _cfg.GitHubToken,
                    progress:       progress,
                    log:            _log,
                    ct:             CancellationToken.None).ConfigureAwait(false);

                // Repoint the active template project at the freshly-pulled one
                // so the next visualiser run picks it up (read at job launch),
                // and record WHICH release is now installed: a durable marker
                // in the project root plus a config fallback. The agent reports
                // the resolved version to the server on the next `hello`.
                _cfg.VisualiserTemplateProjectPath = result.ProjectPath;
                _cfg.VisualiserTemplateVersion     = result.Tag;
                _cfg.VisualiserConnectorVersion    = result.ConnectorTag ?? "";
                // The durable .prism-template.json marker is written by the
                // installer itself (TemplatePuller.PullAsync) into
                // result.ProjectPath — that on-disk marker is the source of
                // truth for the installed version. The config values above are
                // only the fallback TemplateMarker.Resolve uses for a legacy
                // project that has no marker.
                try { _cfg.Save(); }
                catch (Exception ex) { _log.LogWarning(ex, "template pull: failed to persist new template path"); }

                // Re-announce capabilities so the server's workstation row
                // reflects the freshly-installed template version immediately
                // (otherwise it only updates on the next reconnect).
                try { await SendHelloAsync().ConfigureAwait(false); }
                catch (Exception ex) { _log.LogWarning(ex, "template pull: failed to re-send hello after pull"); }

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

    // ---- Install engine plugin from URL --------------------------------

    public sealed record InstallEnginePluginOutcome(
        bool    Started,
        bool    AlreadyRunning,
        string? Error,
        bool    BlockedByUnreal = false,
        IReadOnlyList<Visualiser.UnrealProcessGuard.UnrealProc>? UnrealProcesses = null);

    /// <summary>
    /// Download an Unreal Engine plug-in archive from <paramref name="url"/>
    /// and install its <c>Plugins\</c> contents into
    /// <c>&lt;UnrealEngineRoot&gt;\Engine\Plugins\</c> in the background.
    /// Mirrors <see cref="PullTemplate"/>: single-flight gate, progress in
    /// <see cref="EnginePluginInstall"/>, and the same Unreal-running guard
    /// (engine plug-in DLLs are locked while the editor is open).
    /// </summary>
    /// <param name="url">http(s) URL of a .zip containing a <c>Plugins</c> folder.</param>
    /// <param name="forceCloseUnreal">
    /// When false (default) and Unreal is running, the install is NOT started —
    /// the outcome carries <see cref="InstallEnginePluginOutcome.BlockedByUnreal"/>
    /// + the process list so the UI can confirm. When true the agent
    /// force-closes the detected Unreal processes (waiting for their handles to
    /// release) before copying.
    /// </param>
    public InstallEnginePluginOutcome InstallEnginePlugin(string? url, bool forceCloseUnreal = false)
    {
        var trimmed = (url ?? "").Trim();
        _log.LogInformation("engine plugin install requested (force={Force})", forceCloseUnreal);

        if (string.IsNullOrWhiteSpace(trimmed))
            return new InstallEnginePluginOutcome(false, AlreadyRunning: false, Error: "No URL provided.");

        if (!_enginePluginGate.Wait(0))
        {
            _log.LogWarning("engine plugin install ignored — another install is already in progress");
            return new InstallEnginePluginOutcome(false, AlreadyRunning: true,
                Error: "Another engine-plugin install is already in progress on this agent.");
        }

        // Pre-flight: a running editor locks engine plug-in DLLs. Refuse unless
        // the caller opted into force-close, handing the process list back.
        var runningUnreal = Visualiser.UnrealProcessGuard.Detect(_log);
        if (runningUnreal.Count > 0 && !forceCloseUnreal)
        {
            _enginePluginGate.Release();
            _log.LogWarning(
                "engine plugin install blocked — Unreal Engine is running ({Procs}); operator confirmation required",
                Visualiser.UnrealProcessGuard.Describe(runningUnreal));
            return new InstallEnginePluginOutcome(
                Started: false, AlreadyRunning: false,
                Error: $"Unreal Engine is running ({runningUnreal.Count} instance(s)): " +
                       $"{Visualiser.UnrealProcessGuard.Describe(runningUnreal)}. " +
                       "Installing an engine plug-in requires closing it. Confirm to force-close and continue.",
                BlockedByUnreal: true, UnrealProcesses: runningUnreal);
        }

        var willClose = runningUnreal.Count > 0;
        SetEnginePluginInstall(EnginePluginInstallStatus.Running(
            willClose ? $"closing Unreal ({runningUnreal.Count} process(es))…" : "starting…"));

        _ = Task.Run(async () =>
        {
            try
            {
                var progress = new Progress<string>(msg =>
                    SetEnginePluginInstall(_enginePluginInstall with { Message = msg, UpdatedAt = DateTime.UtcNow }));

                if (forceCloseUnreal)
                {
                    var killed = await Visualiser.UnrealProcessGuard
                        .ForceCloseAllAsync(progress, _log, CancellationToken.None)
                        .ConfigureAwait(false);
                    if (killed > 0)
                        _log.LogInformation("engine plugin install: force-closed {Killed} Unreal process(es)", killed);
                }

                var result = await Visualiser.EnginePluginInstaller.InstallAsync(
                    trimmed, _cfg.UnrealEngineRoot, progress, _log, CancellationToken.None).ConfigureAwait(false);

                _log.LogInformation(
                    "engine plugin install complete: [{Plugins}] -> {Dir}",
                    string.Join(", ", result.InstalledPlugins), result.EnginePluginsDir);
                SetEnginePluginInstall(EnginePluginInstallStatus.Success(result.InstalledPlugins));
            }
            catch (Visualiser.EnginePluginInstallException ex)
            {
                _log.LogError(ex, "engine plugin install failed");
                SetEnginePluginInstall(EnginePluginInstallStatus.Error(ex.Message));
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "engine plugin install failed (unexpected)");
                SetEnginePluginInstall(EnginePluginInstallStatus.Error(ex.Message));
            }
            finally
            {
                _enginePluginGate.Release();
            }
        });

        return new InstallEnginePluginOutcome(true, AlreadyRunning: false, Error: null);
    }

    void SetEnginePluginInstall(EnginePluginInstallStatus status)
    {
        _enginePluginInstall = status;
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
/// Snapshot of the "install engine plugin from URL" action, surfaced on the
/// agent web UI so an operator can watch progress + the installed plug-in list.
/// </summary>
public sealed record EnginePluginInstallStatus(
    string  State,            // idle | running | success | error
    string? Message,
    IReadOnlyList<string>? Plugins,
    DateTime? UpdatedAt)
{
    public static EnginePluginInstallStatus Idle() =>
        new("idle", null, null, null);

    public static EnginePluginInstallStatus Running(string message) =>
        new("running", message, null, DateTime.UtcNow);

    public static EnginePluginInstallStatus Success(IReadOnlyList<string> plugins) =>
        new("success",
            plugins.Count > 0 ? $"installed {plugins.Count} plug-in(s): {string.Join(", ", plugins)}" : "installed",
            plugins, DateTime.UtcNow);

    public static EnginePluginInstallStatus Error(string message) =>
        new("error", message, null, DateTime.UtcNow);
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
    // Portal (external app the UE plug-ins connect to).
    public string?      GitHubToken  { get; set; }
    public string?      PortalUrl    { get; set; }
    // SECRET — blank/omitted leaves the stored key unchanged (see ApplyAsync).
    public string?      RebusApiKey  { get; set; }
}

public sealed record ConfigUpdateResult(bool RestartRequired, AgentConfig Config);
