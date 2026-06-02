using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PRISM.Agent.Config;
using PRISM.Agent.Visualiser;
using PRISM.Agent.Ws;
using PRISM.Contracts;

namespace PRISM.Agent.Pipeline;

/// <summary>
/// Owns the lifecycle of a single
/// <c>PRISM.Visualiser.Orchestrator.exe</c> child process invoked in
/// response to a <c>startVisualisation</c> envelope from the PRISM
/// server.
///
/// <para>
/// Flow:
/// <list type="number">
///   <item><description>
///     Resolve the orchestrator EXE on disk
///     (<see cref="ResolveOrchestratorPath"/>).
///   </description></item>
///   <item><description>
///     Derive the <c>--server prod|dev</c> selector from
///     <see cref="StartVisualisationData.OrbitServerUrl"/>.
///   </description></item>
///   <item><description>
///     Spawn the orchestrator with all required CLI flags and the
///     <c>ORBIT_PAT_*</c> env var set from
///     <see cref="StartVisualisationData.OrbitToken"/>.
///   </description></item>
///   <item><description>
///     Pump stdout line-by-line. For each
///     <c>prism-visualiser/ready/v1</c> or
///     <c>prism-visualiser/failed/v1</c> JSON line, forward a typed
///     <see cref="MessageType.VisualisationReady"/> /
///     <see cref="MessageType.VisualisationFailed"/> envelope upstream
///     to the server. Other schemas (<c>staged/v1</c>,
///     <c>imported/v1</c>) are logged but not forwarded.
///   </description></item>
///   <item><description>
///     On the first <c>ready</c> event, register the local Cirrus URL
///     with <see cref="SignallingBridgeRegistry"/> so inbound
///     signalling frames from the server land on the right socket.
///   </description></item>
///   <item><description>
///     On process exit, drop the signalling bridge for this runId and
///     emit a terminal envelope:
///     <see cref="MessageType.VisualisationEnded"/> on a clean exit
///     after ready,
///     <see cref="MessageType.VisualisationFailed"/> otherwise
///     (unless one already fired).
///   </description></item>
///   <item><description>
///     <see cref="RequestCancel"/> kills the orchestrator process tree
///     (UE + Cirrus included via the orchestrator's own JobObject).
///   </description></item>
/// </list>
/// </para>
/// </summary>
public sealed class VisualiserJob
{
    /// <summary>
    /// Filename of the orchestrator executable inside the agent's
    /// install directory. Bundled under <see cref="OrchestratorSubDir"/>
    /// by the agent's CI publish step (see <c>.github/workflows/agent.yml</c>).
    /// Driven by the orchestrator csproj's
    /// <c>&lt;AssemblyName&gt;prism-visualiser&lt;/AssemblyName&gt;</c>
    /// — NOT the project's filename. If the csproj ever flips the
    /// assembly name, update this constant in the same commit (the
    /// matching <c>VisualiserJobTests.OrchestratorExeName_Matches…</c>
    /// test pins both values).
    /// </summary>
    public const string OrchestratorExeName = "prism-visualiser.exe";

    /// <summary>
    /// Legacy executable filename that early plans assumed (matches the
    /// csproj filename). Kept in the path-probe order so a hand-renamed
    /// release zip from before the AssemblyName landing still works,
    /// and so an operator who runs the orchestrator's standalone
    /// release zip side-by-side picks it up regardless of naming.
    /// </summary>
    public const string OrchestratorExeNameLegacy = "PRISM.Visualiser.Orchestrator.exe";

    /// <summary>
    /// Subfolder of the agent install dir that holds the orchestrator
    /// payload. The orchestrator publishes as a framework-dependent
    /// multi-file folder, so we keep its DLLs isolated from the agent's
    /// own to avoid version conflicts.
    /// </summary>
    public const string OrchestratorSubDir = "Visualiser";

    /// <summary>
    /// Environment variable that, when set, overrides on-disk discovery
    /// of the orchestrator EXE. Useful for dev / CI smoke tests.
    /// </summary>
    public const string OrchestratorPathEnvVar = "PRISM_VISUALISER_ORCHESTRATOR_PATH";

    /// <summary>
    /// DEBUG opt-in env var. When set (truthy) on the agent's
    /// environment it is forwarded to the orchestrator child process,
    /// which then launches the UE <c>-game</c> streaming pass in a
    /// VISIBLE windowed process instead of headless off-screen
    /// rendering. The orchestrator parses the value itself
    /// (<c>1</c>/<c>true</c>/<c>yes</c>/<c>on</c>); the agent only
    /// gates the forward on non-empty so toggling it doesn't require an
    /// agent rebuild. Honoured only when the agent runs in the
    /// operator's interactive desktop session — see <see cref="StartAsync"/>.
    /// </summary>
    public const string VisualiserDebugWindowEnvVar = "PRISM_VISUALISER_DEBUG_WINDOW";

    /// <summary>
    /// DEBUG opt-in env var. When set (truthy) it is forwarded to the
    /// orchestrator child process, which then opens the FULL Unreal Editor
    /// GUI (<c>UnrealEditor.exe</c>) on the imported map AND streams the
    /// level-editor viewport to the browser viewer (the operator controls UE
    /// on the workstation; remote viewers watch the streamed viewport),
    /// instead of the headless / game-window streaming pass. SUPERSEDES
    /// <see cref="VisualiserDebugWindowEnvVar"/> when both are set. The
    /// orchestrator parses the value itself
    /// (<c>1</c>/<c>true</c>/<c>yes</c>/<c>on</c>); the agent only gates the
    /// forward on non-empty so toggling it doesn't require an agent rebuild.
    /// Honoured only when the agent runs in the operator's interactive
    /// desktop session — see <see cref="StartAsync"/>.
    /// </summary>
    public const string VisualiserFullEditorEnvVar = "PRISM_VISUALISER_FULL_EDITOR";

    /// <summary>
    /// Env var forwarded to the orchestrator (full-editor mode) naming the
    /// template Unreal project to open. Mirrors
    /// <see cref="Config.AgentConfig.VisualiserTemplateProjectPath"/>; an
    /// externally-set env var overrides the config value. Defaults inside the
    /// orchestrator to the REBUS_TEMPLATE UNC share when unset.
    /// </summary>
    public const string VisualiserTemplateProjectEnvVar = "PRISM_VISUALISER_TEMPLATE_PROJECT";

    /// <summary>
    /// Env var forwarded to the orchestrator selecting the streaming import
    /// mechanism: <c>1</c> = use the OrbitConnector.UE5 plug-in (pull + load
    /// inside the streamed UE instance), <c>0</c> = use the legacy Interchange
    /// importer. Only forwarded when
    /// <see cref="Config.AgentConfig.VisualiserConnectorImport"/> is non-null (or
    /// an external env var is set); when absent the orchestrator auto-detects
    /// from the fixed project's plug-in. Mirrors the orchestrator's
    /// <c>PRISM_VISUALISER_CONNECTOR_IMPORT</c> / <c>--connector-import</c>.
    /// </summary>
    public const string VisualiserConnectorImportEnvVar = "PRISM_VISUALISER_CONNECTOR_IMPORT";

    /// <summary>
    /// Env var forwarded to the orchestrator carrying the external Portal
    /// base URL the UE plug-ins connect to. The orchestrator passes it to UE
    /// as <c>-PortalUrl="&lt;url&gt;"</c>. Mirrors
    /// <see cref="Config.AgentConfig.PortalUrl"/>. NOT secret — logged
    /// normally. Read at job-launch so a config change applies on the next run.
    /// </summary>
    public const string PortalUrlEnvVar = "PRISM_PORTAL_URL";

    /// <summary>
    /// Env var forwarded to the orchestrator carrying the REBUS Portal API
    /// key the UE plug-ins authenticate with. The orchestrator passes it to UE
    /// as <c>-RebusApiKey=&lt;key&gt;</c>. Mirrors
    /// <see cref="Config.AgentConfig.RebusApiKey"/>. SECRET — its value is
    /// NEVER logged (only a "set"/"unset" boolean), exactly like the existing
    /// <c>-OrbitToken=</c> / <c>ORBIT_PAT_*</c> handling. Forwarded only when
    /// the configured key is non-blank.
    /// </summary>
    public const string RebusApiKeyEnvVar = "PRISM_REBUS_API_KEY";

    /// <summary>
    /// Suggested signalling port the orchestrator's
    /// <c>PortAllocator</c> uses as a starting hint. The orchestrator
    /// will pick a different free port if this one is in use.
    /// </summary>
    public const int DefaultSignallingPortHint = 8888;

    readonly ILogger<VisualiserJob> _log;
    readonly WsClient _ws;
    readonly SignallingBridgeRegistry _bridges;
    readonly VisualiserRunRegistry _registry;
    readonly AgentConfig _cfg;

    Process? _process;
    string? _runId;
    string? _orchestratorPath;
    bool _readyEmitted;
    bool _terminalEmitted;
    string? _cancelReason;
    readonly TaskCompletionSource _exitTcs =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    public VisualiserJob(
        ILogger<VisualiserJob> log,
        WsClient ws,
        SignallingBridgeRegistry bridges,
        VisualiserRunRegistry registry,
        AgentConfig cfg)
    {
        _log = log;
        _ws = ws;
        _bridges = bridges;
        _registry = registry;
        _cfg = cfg;
    }

    /// <summary>
    /// Run id this job was started against, or <c>null</c> if
    /// <see cref="StartAsync"/> hasn't been called yet.
    /// </summary>
    public string? RunId => _runId;

    /// <summary>
    /// Spawn the orchestrator and wire up the stdout/stderr pumps.
    /// Returns once the child process is alive (or has failed to
    /// launch). The actual streaming run continues on background
    /// tasks; await <see cref="WaitForExitAsync(TimeSpan)"/> for
    /// terminal status.
    /// </summary>
    public Task StartAsync(StartVisualisationData data, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(data);
        if (_runId is not null)
            throw new InvalidOperationException("VisualiserJob already started.");

        _runId = data.RunId;

        // The orchestrator's --version flag is required and ThrowIfNullOrWhiteSpace
        // rejects an empty string deep in OrbitReceivePipeline.ReceiveAsync,
        // surfacing as an opaque scaffold_failed error. Fail fast here so the
        // admin log shows a clear message instead.
        // The server dispatcher resolves the latest version when the caller omits
        // versionId, so this branch only fires on mis-configured callers or very
        // old server builds.
        if (string.IsNullOrWhiteSpace(data.VersionId))
        {
            var err =
                "versionId is required but was not provided in the startVisualisation " +
                "envelope. The PRISM server should resolve the latest version before " +
                "dispatching. Upgrade the server to v0.3.3+ or supply an explicit versionId.";
            _log.LogError("visualiser job: {Error}", err);
            EmitFailed(err);
            _registry.Remove(_runId);
            _exitTcs.TrySetResult();
            return Task.CompletedTask;
        }

        var orchestratorPath = ResolveOrchestratorPath();
        if (orchestratorPath is null)
        {
            var probedLocations = string.Join(", ", CandidateOrchestratorPaths());
            var err =
                $"orchestrator binary not found. Tried: {probedLocations}. " +
                "Reinstall the PRISM Agent so the orchestrator sidecar is bundled, " +
                $"or set {OrchestratorPathEnvVar} to the absolute path of {OrchestratorExeName}.";
            _log.LogError("visualiser job: {Error}", err);
            EmitFailed(err);
            _registry.Remove(_runId);
            _exitTcs.TrySetResult();
            return Task.CompletedTask;
        }
        _orchestratorPath = orchestratorPath;

        var serverSelector = ResolveServerSelector(data.OrbitServerUrl);
        var portHint = ResolveSignallingPortHint(data.Slot);

        // The orchestrator's --version flag conflicts with its
        // System.CommandLine version option, so we pass the ORBIT
        // version id as a positional flag.
        var args = new List<string>
        {
            "stream",
            "--server",                serverSelector,
            "--project",               data.ProjectId,
            "--model",                 data.ModelId,
            "--version",               data.VersionId!,
            "--run-id",                data.RunId,
            "--signalling-port-hint",  portHint.ToString(),
            "--json",
        };

        var psi = new ProcessStartInfo
        {
            FileName               = orchestratorPath,
            WorkingDirectory       = Path.GetDirectoryName(orchestratorPath)!,
            UseShellExecute        = false,
            CreateNoWindow         = true,
            RedirectStandardOutput = true,
            RedirectStandardError  = true,
            RedirectStandardInput  = true,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        // The orchestrator reads ORBIT bearer tokens from
        // ORBIT_PAT_PROD / ORBIT_PAT_DEV. The PRISM server forwards
        // the token in the startVisualisation envelope; we surface it
        // to the child process only (never inherit it on the agent
        // itself).
        if (!string.IsNullOrWhiteSpace(data.OrbitToken))
        {
            var envKey = serverSelector switch
            {
                "dev" => "ORBIT_PAT_DEV",
                _     => "ORBIT_PAT_PROD",
            };
            psi.Environment[envKey] = data.OrbitToken;
        }

        // DEBUG: opt the orchestrator into a VISIBLE windowed UE -game pass.
        // Source of truth is the persisted VisualiserDebugWindow setting
        // (tray + web UI), read here at job-launch time so toggling it takes
        // effect on the NEXT run with no agent restart. We OR it with any
        // externally-set env var so the env-var/CLI override still works and
        // nothing regresses. When enabled we set the env var to "1" on the
        // child (the orchestrator parses 1/true/yes/on). NB: the UE window is
        // only visible if THIS agent runs in the operator's interactive
        // desktop session — when the agent runs as a session-0 Windows
        // service the window lands on the hidden session-0 desktop. Pixel
        // Streaming works regardless.
        var envDebugWindow = Environment.GetEnvironmentVariable(VisualiserDebugWindowEnvVar);
        var debugWindow = _cfg.VisualiserDebugWindow || IsTruthy(envDebugWindow);
        if (debugWindow)
        {
            psi.Environment[VisualiserDebugWindowEnvVar] = "1";
            _log.LogWarning(
                "visualiser job: debug window ENABLED (config={CfgValue} env={EnvValue}) — orchestrator will launch UE -game WINDOWED. " +
                "The window is only visible if the PRISM agent runs interactively (not as a session-0 service).",
                _cfg.VisualiserDebugWindow, envDebugWindow ?? "<unset>");
        }

        // DEBUG: opt the orchestrator into opening the FULL Unreal Editor GUI
        // on the imported map for inspection. Same persisted-config + env-var
        // OR pattern as debug-window; read at job-launch so toggling it takes
        // effect on the NEXT run with no agent restart. This SUPERSEDES the
        // debug-window mode in the orchestrator and is INSPECTION-ONLY (no
        // browser Pixel Streaming). The editor window is only visible if THIS
        // agent runs in the operator's interactive desktop session.
        var envFullEditor = Environment.GetEnvironmentVariable(VisualiserFullEditorEnvVar);
        var fullEditor = _cfg.VisualiserFullEditor || IsTruthy(envFullEditor);
        if (fullEditor)
        {
            psi.Environment[VisualiserFullEditorEnvVar] = "1";
            _log.LogWarning(
                "visualiser job: FULL EDITOR ENABLED (config={CfgValue} env={EnvValue}) — orchestrator will open the FIXED template project " +
                "in the full Unreal Editor GUI AND stream the level-editor viewport to the browser viewer (supersedes debug-window; " +
                "ORBIT import is bypassed in this baseline). The operator controls UE on the workstation; remote viewers watch the " +
                "streamed viewport. The editor window is only visible if the PRISM agent runs interactively (not as a session-0 service).",
                _cfg.VisualiserFullEditor, envFullEditor ?? "<unset>");
        }

        // Forward the fixed template/visualiser project path the orchestrator
        // should open. This drives BOTH the full-editor baseline AND the new
        // connector-import streaming path (where the orchestrator launches this
        // project in -game + PixelStreaming and the bundled OrbitConnector.UE5
        // plug-in pulls + loads the model). Always forwarded (harmless on the
        // legacy Interchange path, which ignores it). Honour an externally-set
        // env var (override), else the persisted config value. Read at
        // job-launch so a config change applies next run.
        var envTemplate = Environment.GetEnvironmentVariable(VisualiserTemplateProjectEnvVar);
        var template = !string.IsNullOrWhiteSpace(envTemplate)
            ? envTemplate
            : _cfg.VisualiserTemplateProjectPath;
        if (!string.IsNullOrWhiteSpace(template))
        {
            psi.Environment[VisualiserTemplateProjectEnvVar] = template;
            _log.LogInformation(
                "visualiser job: template project path -> {Path} (config={CfgValue} env={EnvValue})",
                template, _cfg.VisualiserTemplateProjectPath ?? "<unset>", envTemplate ?? "<unset>");
        }

        // Forward the connector-import selector to the orchestrator. Tri-state:
        //   - external env var (any value) wins and is passed through verbatim;
        //   - else the persisted config bool? maps true->"1", false->"0";
        //   - else (null) we forward NOTHING so the orchestrator auto-detects
        //     from whether the fixed project ships the OrbitConnector plug-in.
        var envConnector = Environment.GetEnvironmentVariable(VisualiserConnectorImportEnvVar);
        if (!string.IsNullOrWhiteSpace(envConnector))
        {
            psi.Environment[VisualiserConnectorImportEnvVar] = envConnector;
            _log.LogInformation(
                "visualiser job: connector-import -> {Value} (from env override)", envConnector);
        }
        else if (_cfg.VisualiserConnectorImport is bool connectorPref)
        {
            psi.Environment[VisualiserConnectorImportEnvVar] = connectorPref ? "1" : "0";
            _log.LogInformation(
                "visualiser job: connector-import -> {Value} (config)",
                connectorPref ? "on" : "off (Interchange)");
        }
        else
        {
            _log.LogInformation(
                "visualiser job: connector-import unset (config=auto) — orchestrator will auto-detect " +
                "the OrbitConnector plug-in in the fixed project and fall back to Interchange if absent.");
        }

        // Forward the external Portal connection so the orchestrator can hand
        // it to UE (-PortalUrl / -RebusApiKey). Honour an externally-set env
        // var (override), else the persisted config value. The URL is NOT
        // secret and is logged; the API KEY is a SECRET and follows the exact
        // OrbitToken precedent — its value is set on the child env but NEVER
        // logged (we only log whether it is set). Read at job-launch so a
        // config change applies on the next run.
        var envPortalUrl = Environment.GetEnvironmentVariable(PortalUrlEnvVar);
        var portalUrl = !string.IsNullOrWhiteSpace(envPortalUrl)
            ? envPortalUrl
            : _cfg.PortalUrl;
        if (!string.IsNullOrWhiteSpace(portalUrl))
        {
            psi.Environment[PortalUrlEnvVar] = portalUrl.Trim();
            _log.LogInformation(
                "visualiser job: portal url -> {Url} (config={CfgValue} env={EnvValue})",
                portalUrl.Trim(), _cfg.PortalUrl ?? "<unset>", envPortalUrl ?? "<unset>");
        }

        // SECRET: never log the key value. Mirror the ORBIT_PAT_* / -OrbitToken
        // precedent above — set it on the child env only, and emit only a
        // boolean so the env dump stays clean.
        var envRebusKey = Environment.GetEnvironmentVariable(RebusApiKeyEnvVar);
        var rebusApiKey = !string.IsNullOrWhiteSpace(envRebusKey)
            ? envRebusKey
            : _cfg.RebusApiKey;
        if (!string.IsNullOrWhiteSpace(rebusApiKey))
        {
            psi.Environment[RebusApiKeyEnvVar] = rebusApiKey.Trim();
            _log.LogInformation(
                "visualiser job: REBUS Portal API key forwarded to orchestrator (set=true; value redacted)");
        }
        else
        {
            _log.LogInformation(
                "visualiser job: no REBUS Portal API key configured (set=false) — orchestrator will omit -RebusApiKey");
        }

        if (!string.IsNullOrWhiteSpace(_cfg.UnrealEngineRoot))
        {
            // The orchestrator's UnrealEnvironment.TryResolve()
            // honours the env var first, the default Epic Games path
            // second, then the registry. Passing the configured root
            // through guarantees the orchestrator targets the engine
            // the workstation operator picked.
            //
            // We normalize defensively before assigning: the JSON
            // round-trip from agent-config.json + the WinForms
            // SettingsForm text box have both historically introduced
            // leading BOM characters / trailing whitespace / mixed
            // separators that pass IsNullOrWhiteSpace but make
            // Directory.Exists return false in the orchestrator. The
            // orchestrator itself does the same normalization on its
            // end (UnrealEnvironment.NormalizeRoot), but normalizing
            // here too lets us log the exact env-var value the child
            // sees so future "ue_root_not_found" reports can be
            // diagnosed without a remote-debug session on PC01.
            var raw = _cfg.UnrealEngineRoot;
            var normalized = NormalizeUnrealRoot(raw);
            if (!string.Equals(raw, normalized, StringComparison.Ordinal))
            {
                _log.LogInformation(
                    "visualiser job: normalized UNREAL_ENGINE_ROOT raw={Raw} normalized={Normalized}",
                    raw, normalized);
            }
            else
            {
                _log.LogInformation(
                    "visualiser job: UNREAL_ENGINE_ROOT={Value}", normalized);
            }
            psi.Environment["UNREAL_ENGINE_ROOT"] = normalized;
        }
        else
        {
            _log.LogInformation(
                "visualiser job: agent config has no UnrealEngineRoot set; orchestrator will fall back to default Epic Games path + registry probes");
        }

        Process proc;
        try
        {
            proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.Exited += OnProcessExited;
            if (!proc.Start())
                throw new InvalidOperationException("Process.Start returned false.");
        }
        catch (Exception ex)
        {
            _log.LogError(ex,
                "visualiser job: failed to spawn orchestrator at {Path}",
                orchestratorPath);
            EmitFailed($"failed to spawn orchestrator: {ex.Message}");
            _registry.Remove(_runId);
            _exitTcs.TrySetResult();
            return Task.CompletedTask;
        }

        _process = proc;
        _log.LogInformation(
            "visualiser job: spawned orchestrator pid={Pid} runId={RunId} server={Server} project={Project} model={Model} version={Version} portHint={Port}",
            proc.Id, data.RunId, serverSelector, data.ProjectId, data.ModelId,
            data.VersionId ?? string.Empty, portHint);

        // stdout JSON line pump on a dedicated background task so the
        // dispatcher thread never blocks. Reads concurrently with the
        // stderr pump.
        _ = Task.Run(() => PumpStdoutAsync(proc), CancellationToken.None);
        _ = Task.Run(() => PumpStderrAsync(proc), CancellationToken.None);

        // Hook external cancellation onto the same Kill path
        // RequestCancel uses, so the host shutdown token terminates a
        // long-running stream the same way an operator-initiated
        // cancel does.
        if (ct.CanBeCanceled)
        {
            ct.Register(() => RequestCancel("agent host cancellation"));
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// Request a graceful cancellation of this run. Kills the
    /// orchestrator process tree (UE + Cirrus included via the
    /// orchestrator's JobObject). Idempotent.
    /// </summary>
    public void RequestCancel(string? reason)
    {
        _cancelReason ??= reason;
        var proc = _process;
        if (proc is null || proc.HasExited) return;

        try
        {
            _log.LogInformation(
                "visualiser job: cancelling runId={RunId} pid={Pid} reason={Reason}",
                _runId, proc.Id, reason ?? "<none>");
            proc.Kill(entireProcessTree: true);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex,
                "visualiser job: kill failed for runId={RunId} pid={Pid}",
                _runId, proc.Id);
        }
    }

    /// <summary>
    /// Await final process exit + terminal-event emission. Returns
    /// once both have completed, or after <paramref name="timeout"/>
    /// elapses.
    /// </summary>
    public async Task WaitForExitAsync(TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);
        var completed = await Task.WhenAny(
            _exitTcs.Task,
            Task.Delay(Timeout.Infinite, cts.Token)).ConfigureAwait(false);
        if (completed != _exitTcs.Task)
        {
            _log.LogWarning("visualiser job: WaitForExitAsync timed out after {Timeout}", timeout);
        }
    }

    /* ----------------------------------------------------------------- */
    /* Internals                                                         */
    /* ----------------------------------------------------------------- */

    void OnProcessExited(object? sender, EventArgs e)
    {
        var proc = _process!;
        var runId = _runId ?? string.Empty;
        int exitCode;
        try { exitCode = proc.ExitCode; } catch { exitCode = -1; }

        _log.LogInformation(
            "visualiser job: orchestrator exit runId={RunId} pid={Pid} code={Code} ready={Ready}",
            runId, proc.Id, exitCode, _readyEmitted);

        // Always drop the bridge — the orchestrator's local Cirrus is
        // gone now, so any pending server signalling frames have
        // nowhere to land.
        if (!string.IsNullOrEmpty(runId))
        {
            _ = _bridges.DropAsync(runId);
        }

        if (!_terminalEmitted)
        {
            if (_readyEmitted)
            {
                // We already told the server the run was streaming;
                // close it out with the matching ended envelope so the
                // visualiserRuns row transitions to its terminal
                // state cleanly.
                EmitEnded(_cancelReason ?? $"orchestrator exit code {exitCode}");
            }
            else
            {
                // Process died before emitting a ready event. The
                // orchestrator's stdout pump may have already printed
                // a failed/v1 line and been picked up by
                // PumpStdoutAsync; if not, synthesize one from the
                // exit code.
                var msg = _cancelReason is not null
                    ? $"orchestrator cancelled: {_cancelReason}"
                    : $"orchestrator exited with code {exitCode} before reporting ready";
                EmitFailed(msg);
            }
        }

        if (!string.IsNullOrEmpty(runId))
        {
            _registry.Remove(runId);
        }
        _exitTcs.TrySetResult();
    }

    async Task PumpStdoutAsync(Process proc)
    {
        try
        {
            string? line;
            while ((line = await proc.StandardOutput.ReadLineAsync().ConfigureAwait(false)) is not null)
            {
                HandleStdoutLine(line);
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "visualiser job: stdout pump failed runId={RunId}", _runId);
        }
    }

    async Task PumpStderrAsync(Process proc)
    {
        try
        {
            string? line;
            while ((line = await proc.StandardError.ReadLineAsync().ConfigureAwait(false)) is not null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                _log.LogInformation("[orchestrator stderr runId={RunId}] {Line}", _runId, line);
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "visualiser job: stderr pump failed runId={RunId}", _runId);
        }
    }

    void HandleStdoutLine(string line)
    {
        var trimmed = line.Trim();
        if (trimmed.Length == 0 || trimmed[0] != '{')
        {
            // Non-JSON stdout (banner, debug). Forward to log only.
            _log.LogInformation("[orchestrator stdout runId={RunId}] {Line}", _runId, line);
            return;
        }

        try
        {
            using var doc = JsonDocument.Parse(trimmed);
            if (!doc.RootElement.TryGetProperty("schema", out var schemaEl))
            {
                _log.LogDebug("[orchestrator stdout runId={RunId}] (no schema) {Line}", _runId, line);
                return;
            }
            var schema = schemaEl.GetString() ?? string.Empty;
            switch (schema)
            {
                case "prism-visualiser/ready/v1":
                    HandleReadyLine(doc.RootElement);
                    break;
                case "prism-visualiser/failed/v1":
                    HandleFailedLine(doc.RootElement);
                    break;
                case "prism-visualiser/staged/v1":
                case "prism-visualiser/imported/v1":
                case "prism-visualiser/connector-import/v1":
                case "prism-visualiser/mvr-ready/v1":
                    // Phase-progress events. Useful for diagnostics but
                    // not part of the agent <-> server contract yet.
                    _log.LogInformation("[orchestrator stdout runId={RunId}] {Schema}: {Line}", _runId, schema, line);
                    break;
                default:
                    _log.LogDebug("[orchestrator stdout runId={RunId}] unknown schema {Schema}: {Line}", _runId, schema, line);
                    break;
            }
        }
        catch (JsonException ex)
        {
            _log.LogDebug(ex, "[orchestrator stdout runId={RunId}] non-JSON line: {Line}", _runId, line);
        }
    }

    void HandleReadyLine(JsonElement root)
    {
        var status = root.TryGetProperty("status", out var statusEl)
            ? statusEl.GetString()
            : null;
        var runId = root.TryGetProperty("runId", out var runIdEl)
            ? runIdEl.GetString() ?? _runId
            : _runId;

        if (string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase))
        {
            var err = root.TryGetProperty("error", out var errEl)
                ? errEl.GetString() ?? "orchestrator reported status=failed"
                : "orchestrator reported status=failed";
            EmitFailed(err);
            return;
        }

        // status == "ready" (or any non-"failed" value; treat as ready)
        var signallingUrl = root.TryGetProperty("signallingUrl", out var sigEl)
            ? sigEl.GetString() ?? string.Empty
            : string.Empty;
        var streamerId = root.TryGetProperty("streamerId", out var streamerEl)
            ? streamerEl.GetString()
            : null;
        var playerUrl = root.TryGetProperty("playerUrl", out var playerEl)
            ? playerEl.GetString()
            : null;

        _log.LogInformation(
            "visualiser job: orchestrator reports ready runId={RunId} signallingUrl={Signalling} playerUrl={Player} streamerId={Streamer}",
            runId, signallingUrl, playerUrl ?? string.Empty, streamerId ?? string.Empty);

        if (!string.IsNullOrEmpty(signallingUrl) && Uri.TryCreate(signallingUrl, UriKind.Absolute, out var localUri))
        {
            // Front-load the bridge so the first inbound
            // signallingFrame envelope from the server lands on the
            // orchestrator's local Cirrus instead of the default
            // fallback URL.
            _bridges.RegisterLocalCirrus(runId ?? _runId ?? string.Empty, localUri);
        }
        else
        {
            _log.LogWarning(
                "visualiser job: ready event missing usable signallingUrl runId={RunId} value={Value}",
                runId, signallingUrl);
        }

        _readyEmitted = true;
        _ = _ws.SendAsync(MessageType.VisualisationReady, new VisualisationReadyData
        {
            RunId         = runId ?? _runId ?? string.Empty,
            SignallingUrl = signallingUrl,
            StreamerId    = streamerId,
        });
    }

    void HandleFailedLine(JsonElement root)
    {
        var runId = root.TryGetProperty("runId", out var runIdEl)
            ? runIdEl.GetString() ?? _runId
            : _runId;
        var code = root.TryGetProperty("code", out var codeEl)
            ? codeEl.GetString() ?? "orchestrator_failed"
            : "orchestrator_failed";
        var message = root.TryGetProperty("message", out var msgEl)
            ? msgEl.GetString() ?? code
            : code;
        var combined = $"{code}: {message}";
        _log.LogError("visualiser job: orchestrator failed runId={RunId} code={Code} message={Message}",
            runId, code, message);
        EmitFailed(combined);
    }

    void EmitFailed(string error)
    {
        if (_terminalEmitted) return;
        _terminalEmitted = true;
        if (string.IsNullOrEmpty(_runId)) return;
        _ = _ws.SendAsync(MessageType.VisualisationFailed, new VisualisationFailedData
        {
            RunId = _runId,
            Error = error,
        });
    }

    void EmitEnded(string reason)
    {
        if (_terminalEmitted) return;
        _terminalEmitted = true;
        if (string.IsNullOrEmpty(_runId)) return;
        _ = _ws.SendAsync(MessageType.VisualisationEnded, new VisualisationEndedData
        {
            RunId  = _runId,
            Reason = reason,
        });
    }

    /* ----------------------------------------------------------------- */
    /* Static helpers (testable surface)                                 */
    /* ----------------------------------------------------------------- */

    /// <summary>
    /// Translate an ORBIT base URL into the orchestrator's
    /// <c>--server</c> selector. Anything matching
    /// <c>orbit-dev</c> in the host name maps to <c>dev</c>; anything
    /// else (including the canonical
    /// <c>orbit.rebus.industries</c>) maps to <c>prod</c>.
    /// </summary>
    public static string ResolveServerSelector(string? orbitServerUrl)
    {
        if (string.IsNullOrWhiteSpace(orbitServerUrl)) return "prod";
        if (Uri.TryCreate(orbitServerUrl, UriKind.Absolute, out var uri))
        {
            var host = uri.Host;
            return host.Contains("orbit-dev", StringComparison.OrdinalIgnoreCase)
                ? "dev"
                : "prod";
        }
        return orbitServerUrl.Contains("orbit-dev", StringComparison.OrdinalIgnoreCase)
            ? "dev"
            : "prod";
    }

    /// <summary>
    /// Strip leading/trailing whitespace + BOM / zero-width characters
    /// from an UE root path the operator entered (or that round-tripped
    /// through agent-config.json with a UTF-8 BOM). Mirrors the
    /// orchestrator's <c>UnrealEnvironment.NormalizeRoot</c> minus the
    /// <see cref="Path.GetFullPath(string)"/> call (we DO NOT want the
    /// agent to resolve relative paths against its own working dir —
    /// that would be a footgun, since the agent runs as a service from
    /// <c>%ProgramFiles%\PRISM.Agent</c>). Returns the raw string when
    /// no normalization is needed; otherwise returns the cleaned form.
    /// </summary>
    public static string NormalizeUnrealRoot(string? root)
    {
        if (string.IsNullOrEmpty(root)) return string.Empty;
        var trimmed = root.Trim();
        var start = 0;
        while (start < trimmed.Length && IsInvisible(trimmed[start])) start++;
        var end = trimmed.Length - 1;
        while (end >= start && IsInvisible(trimmed[end])) end--;
        if (start > end) return string.Empty;
        return trimmed.Substring(start, end - start + 1);

        static bool IsInvisible(char ch) =>
            ch == '\uFEFF' || ch == '\u200B' || ch == '\u200C' || ch == '\u200D';
    }

    /// <summary>
    /// Spread the per-slot signalling port hint a little so two
    /// concurrent visualiser sessions on the same workstation don't
    /// collide on the orchestrator's first bind attempt. The hint is
    /// only a starting point — the orchestrator's PortAllocator will
    /// pick a different free port if needed.
    /// </summary>
    public static int ResolveSignallingPortHint(int slot)
    {
        var offset = Math.Max(0, slot) % 20;
        return DefaultSignallingPortHint + (offset * 10);
    }

    /// <summary>
    /// Lenient truthy test for the <see cref="VisualiserDebugWindowEnvVar"/>
    /// override. Matches the orchestrator's own parser
    /// (<c>1</c>/<c>true</c>/<c>yes</c>/<c>on</c>, case-insensitive); any
    /// other value (or null/empty) is false.
    /// </summary>
    public static bool IsTruthy(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        return value.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "yes" or "on" => true,
            _ => false,
        };
    }

    /// <summary>
    /// Probe well-known locations for the orchestrator EXE. Returns
    /// the first existing path, or <c>null</c> when none of the
    /// candidates resolve.
    /// </summary>
    public string? ResolveOrchestratorPath()
    {
        foreach (var candidate in CandidateOrchestratorPaths())
        {
            if (!string.IsNullOrEmpty(candidate) && File.Exists(candidate))
            {
                return candidate;
            }
        }
        return null;
    }

    /// <summary>
    /// Enumerate the on-disk locations
    /// <see cref="ResolveOrchestratorPath"/> probes, in precedence
    /// order. Exposed so the failure message can list every spot
    /// we looked.
    /// </summary>
    public IEnumerable<string> CandidateOrchestratorPaths()
    {
        // 1. Explicit override via env var (dev / CI smoke tests).
        var envOverride = Environment.GetEnvironmentVariable(OrchestratorPathEnvVar);
        if (!string.IsNullOrEmpty(envOverride)) yield return envOverride;

        // 2. Explicit override via agent-config.json.
        if (!string.IsNullOrWhiteSpace(_cfg.VisualiserOrchestratorPath))
            yield return _cfg.VisualiserOrchestratorPath!;

        // 3. Side-by-side with the running PRISM.Agent.exe under
        //    Visualiser\. This is the layout the agent installer ships.
        var baseDir = AppContext.BaseDirectory;
        if (!string.IsNullOrEmpty(baseDir))
        {
            yield return Path.Combine(baseDir, OrchestratorSubDir, OrchestratorExeName);
            yield return Path.Combine(baseDir, OrchestratorSubDir, OrchestratorExeNameLegacy);
            // Defensive: an older payload may have flattened the
            // orchestrator into the agent install root.
            yield return Path.Combine(baseDir, OrchestratorExeName);
            yield return Path.Combine(baseDir, OrchestratorExeNameLegacy);
        }

        // 4. Conventional Inno-installed Program Files location.
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (!string.IsNullOrEmpty(pf))
        {
            yield return Path.Combine(pf, "PRISM.Agent", OrchestratorSubDir, OrchestratorExeName);
            yield return Path.Combine(pf, "PRISM.Agent", OrchestratorSubDir, OrchestratorExeNameLegacy);
        }
    }
}
