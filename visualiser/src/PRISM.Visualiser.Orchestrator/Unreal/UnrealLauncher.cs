using System.Diagnostics;
using System.Globalization;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;

using Serilog;

using PRISM.Visualiser.Orchestrator.Process;

namespace PRISM.Visualiser.Orchestrator.Unreal;

/// <summary>
/// Spawns <c>UnrealEditor-Cmd.exe</c> against a scaffolded per-run
/// project, runs the rendered <c>import_orbit.py</c> via
/// <c>-run=PythonScript -script=&lt;path&gt;</c>, and parses the ready / error
/// marker lines the python script emits to stdout.
///
/// <para>
/// Marker contract (mirrors <c>import_orbit.py</c>'s end-of-script
/// emission):
/// <code>
///   PRISM_VISUALISER_READY {"runId":"...","levelPath":"...", "assetCount":42, "importDurationMs":12345}
///   PRISM_VISUALISER_ERROR {"code":"import_failed","message":"..."}
/// </code>
/// Either marker terminates the wait. The python script <c>sys.exit</c>s
/// with a non-zero code on the error path so the editor returns a
/// non-zero exit code as well; the launcher cross-checks this.
/// </para>
///
/// <para>
/// All UE stdout is forwarded line-by-line to Serilog under the
/// <c>ue-editor</c> channel (warnings on stderr) so logs survive even
/// if the import never reaches a marker.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class UnrealLauncher
{
    /// <summary>Marker prefix the python ready emission uses.</summary>
    public const string ReadyMarkerPrefix = "PRISM_VISUALISER_READY ";

    /// <summary>Marker prefix the python error emission uses.</summary>
    public const string ErrorMarkerPrefix = "PRISM_VISUALISER_ERROR ";

    /// <summary>Phase J marker — the MVR/GDTF import script emits this on success.</summary>
    public const string MvrReadyMarkerPrefix = "PRISM_VISUALISER_MVR_READY ";

    /// <summary>Phase J marker — the MVR/GDTF import script emits this on failure.</summary>
    public const string MvrErrorMarkerPrefix = "PRISM_VISUALISER_MVR_ERROR ";

    /// <summary>Default wait budget per the plan (10 min).</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(10);

    /// <summary>Channel string used when forwarding UE stdout to Serilog.</summary>
    public const string LogChannel = "ue-editor";

    private readonly UnrealInstall _install;
    private readonly JobObject _job;
    private readonly ILogger _log;

    public UnrealLauncher(UnrealInstall install, JobObject job, ILogger log)
    {
        _install = install ?? throw new ArgumentNullException(nameof(install));
        _job = job ?? throw new ArgumentNullException(nameof(job));
        _log = log ?? throw new ArgumentNullException(nameof(log));
    }

    /// <summary>
    /// Launch UE for an import run. Blocks until the python script emits
    /// a ready / error marker, the process exits, or
    /// <paramref name="timeout"/> elapses.
    /// </summary>
    public async Task<UnrealImportResult> LaunchImportAsync(
        ScaffoldResult scaffold,
        TimeSpan? timeout = null,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(scaffold);
        timeout ??= DefaultTimeout;

        var psi = BuildStartInfoCore(_install, scaffold);
        _log.Information(
            "ue launch project={Project} python={Python} timeoutMs={TimeoutMs}",
            scaffold.UprojectPath, scaffold.PythonScriptPath, (int)timeout.Value.TotalMilliseconds);

        using var process = new System.Diagnostics.Process { StartInfo = psi };
        var readyTcs = new TaskCompletionSource<UnrealReadyMarker>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var errorTcs = new TaskCompletionSource<UnrealErrorMarker>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        var ueChannel = _log.ForContext("channel", LogChannel);
        process.OutputDataReceived += (_, e) =>
        {
            var line = e.Data;
            if (line is null) return;
            ueChannel.Information("{Line}", line);
            TryConsumeMarker(line, readyTcs, errorTcs);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            var line = e.Data;
            if (line is null) return;
            ueChannel.Warning("{Line}", line);
            // UE often double-prints log lines on stderr — markers are
            // valid here too. Mirror the stdout consumer.
            TryConsumeMarker(line, readyTcs, errorTcs);
        };

        var startedAt = DateTime.UtcNow;
        if (!process.Start())
        {
            throw new UnrealLaunchException(
                $"Failed to start UnrealEditor-Cmd.exe at '{_install.EditorCmdPath}'.");
        }

        try
        {
            _job.AddProcess(process.Id);
        }
        catch (Exception ex)
        {
            _log.Warning(ex,
                "ue launch: failed to add UE pid={Pid} to JobObject; KILL_ON_JOB_CLOSE will not cover it.",
                process.Id);
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        // Wait for either marker, the process exiting, the cancellation
        // token, or the configured timeout — whichever fires first.
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout.Value);

        var exitTask = process.WaitForExitAsync(timeoutCts.Token);

        // Task.WhenAny never throws; it surfaces the first task to
        // complete (including a Canceled exitTask). Discriminating
        // outcomes happens on the awaiting side below.
        var winner = await Task.WhenAny(
            readyTcs.Task,
            errorTcs.Task,
            exitTask).ConfigureAwait(false);

        // Even if a marker fired, drain the editor exit so Job Object
        // cleanup completes deterministically.
        if (winner == readyTcs.Task)
        {
            var ready = await readyTcs.Task.ConfigureAwait(false);
            await WaitForExitOrKillAsync(process, timeout.Value, timeoutCts.Token).ConfigureAwait(false);
            var elapsed = DateTime.UtcNow - startedAt;
            _log.Information(
                "ue import ready runId={RunId} level={Level} assets={AssetCount} elapsedMs={ElapsedMs}",
                ready.RunId, ready.LevelPath, ready.AssetCount, (long)elapsed.TotalMilliseconds);
            return new UnrealImportResult(
                Status: UnrealImportStatus.Ready,
                Marker: ready,
                ExitCode: SafeExitCode(process),
                ProcessId: process.Id,
                Elapsed: elapsed,
                Error: null);
        }

        if (winner == errorTcs.Task)
        {
            var err = await errorTcs.Task.ConfigureAwait(false);
            await WaitForExitOrKillAsync(process, timeout.Value, timeoutCts.Token).ConfigureAwait(false);
            var elapsed = DateTime.UtcNow - startedAt;
            _log.Error(
                "ue import error code={Code} message={Message} elapsedMs={ElapsedMs}",
                err.Code, err.Message, (long)elapsed.TotalMilliseconds);
            return new UnrealImportResult(
                Status: UnrealImportStatus.PythonError,
                Marker: null,
                ExitCode: SafeExitCode(process),
                ProcessId: process.Id,
                Elapsed: elapsed,
                Error: err);
        }

        // Process exited without emitting a marker. That's a real
        // failure — the editor either crashed (non-zero exit code) or
        // the python script bailed before our try/except got to print
        // its error marker (zero exit code with no marker).
        if (winner == exitTask)
        {
            var elapsed = DateTime.UtcNow - startedAt;
            // The exit task completed because the process ended,
            // possibly because the linked timeout fired and
            // process.WaitForExitAsync threw — handle both cases here.
            if (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                throw new UnrealLaunchTimeoutException(
                    $"UE import did not emit a ready marker within {timeout.Value.TotalSeconds:F0}s.");
            }
            try
            {
                await exitTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                throw new UnrealLaunchTimeoutException(
                    $"UE import did not emit a ready marker within {timeout.Value.TotalSeconds:F0}s.");
            }
            var exitCode = SafeExitCode(process);
            _log.Error(
                "ue import exited without ready marker exit={Exit} elapsedMs={ElapsedMs}",
                exitCode, (long)elapsed.TotalMilliseconds);
            return new UnrealImportResult(
                Status: UnrealImportStatus.NoMarker,
                Marker: null,
                ExitCode: exitCode,
                ProcessId: process.Id,
                Elapsed: elapsed,
                Error: null);
        }

        throw new InvalidOperationException("Unreachable: Task.WhenAny returned an unknown task.");
    }

    /// <summary>
    /// Build the <see cref="ProcessStartInfo"/> the launcher uses. Public
    /// + static so tests can assert the argument string without spawning UE.
    /// </summary>
    public static ProcessStartInfo BuildStartInfoForTest(
        UnrealInstall install, ScaffoldResult scaffold)
    {
        ArgumentNullException.ThrowIfNull(install);
        ArgumentNullException.ThrowIfNull(scaffold);
        return BuildStartInfoCore(install, scaffold);
    }

    private static ProcessStartInfo BuildStartInfoCore(UnrealInstall install, ScaffoldResult scaffold)
    {
        var psi = new ProcessStartInfo
        {
            FileName = install.EditorCmdPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = scaffold.ProjectRoot,
        };

        // Argument order matches the canonical UE 5.7 commandlet form:
        //   UnrealEditor-Cmd.exe <project.uproject> -run=PythonScript -script="<script.py>"
        //
        // CRITICAL: when -run=PythonScript is present, UE enters the
        // PythonScriptCommandlet code path. That commandlet reads the
        // Python source path from the -script=<path> token. The
        // -ExecutePythonScript=<path> token is only honoured by the
        // *editor-startup* PythonScript path (non-commandlet); when the
        // editor is launched as a commandlet it explicitly rejects it:
        //   LogEditorPythonExecuter: Error: -ExecutePythonScript cannot
        //   be used by a commandlet. Use -run=PythonScript instead?
        // That diagnostic surfaced on PC01 (v0.3.4) and meant the
        // import_orbit.py never ran. Using -script=<path> here matches
        // the canonical UE 5.7 docs and the upstream
        // PythonScriptCommandlet implementation.
        // Headless / unattended flags suppress splash + interactive prompts.
        psi.ArgumentList.Add(scaffold.UprojectPath);
        psi.ArgumentList.Add("-run=PythonScript");
        psi.ArgumentList.Add(string.Format(
            CultureInfo.InvariantCulture,
            "-script={0}", scaffold.PythonScriptPath));
        psi.ArgumentList.Add("-Unattended");
        psi.ArgumentList.Add("-NoSplash");
        psi.ArgumentList.Add("-NoPause");
        psi.ArgumentList.Add("-NullRHI");
        psi.ArgumentList.Add("-stdout");
        psi.ArgumentList.Add("-FullStdOutLogOutput");

        return psi;
    }

    // ----------------------------------------------------------------
    // Phase F — -game / Pixel Streaming launch
    // ----------------------------------------------------------------

    /// <summary>Default resolution the game-mode launcher requests.</summary>
    public const int DefaultGameResX = 1920;

    /// <summary>Default resolution the game-mode launcher requests.</summary>
    public const int DefaultGameResY = 1080;

    /// <summary>Default window width used by the debug-window (-windowed) launch.</summary>
    public const int DefaultDebugResX = 1280;

    /// <summary>Default window height used by the debug-window (-windowed) launch.</summary>
    public const int DefaultDebugResY = 720;

    /// <summary>
    /// Launch UE in <c>-game</c> mode with PixelStreaming flags. Returns
    /// a handle wrapping the started <see cref="System.Diagnostics.Process"/>
    /// — the caller is responsible for awaiting the streamer-connected
    /// event on the Cirrus side (UE itself doesn't emit a structured
    /// ready marker in -game mode) and for tearing the process down
    /// when the run ends.
    ///
    /// <para>
    /// Why <c>UnrealEditor-Cmd.exe</c> for <c>-game</c> mode (and not the
    /// "Win32 GUI subsystem" <c>UnrealEditor.exe</c>):
    /// </para>
    ///
    /// <list type="bullet">
    ///   <item><description>
    ///     <c>UnrealEditor-Cmd.exe</c> and <c>UnrealEditor.exe</c> are
    ///     the same Unreal monolith linked against different Win32
    ///     subsystems. The <c>-Cmd</c> build uses the Console subsystem,
    ///     so its stdout / stderr are inherited by us cleanly via
    ///     <see cref="ProcessStartInfo.RedirectStandardOutput"/>.
    ///     <c>UnrealEditor.exe</c> attaches to a Windows GUI subsystem;
    ///     its <c>log.AddLogListener(stdout)</c> path is unreliable
    ///     when launched from a non-console parent like our test
    ///     harness.
    ///   </description></item>
    ///   <item><description>
    ///     <c>-game</c> mode is fully supported by the <c>-Cmd</c>
    ///     binary — Unreal's command-line dispatch picks the
    ///     <c>UGameEngine</c> path based on the <c>-game</c> switch,
    ///     not on which subsystem the binary was linked against.
    ///     Pixel Streaming 2 examples in the UE 5.7 docs use both
    ///     binaries interchangeably; we standardise on <c>-Cmd</c>
    ///     because we already have its path resolved from Phase E.
    ///   </description></item>
    ///   <item><description>
    ///     PS2 still creates a real D3D12 device + NVENC encoder when
    ///     <c>-RenderOffScreen</c> is set: the offscreen flag bypasses
    ///     window presentation but the GPU pipeline is fully active.
    ///     We intentionally do NOT pass <c>-NullRHI</c> for the
    ///     game-mode launch (it would disable the very RHI that
    ///     drives the streamer).
    ///   </description></item>
    /// </list>
    /// </summary>
    public UnrealGameHandle LaunchGameMode(
        ScaffoldResult scaffold,
        string signallingUrl,
        string streamerId,
        int resX = DefaultGameResX,
        int resY = DefaultGameResY,
        bool debugWindow = false,
        OrbitImportParams? orbitImport = null)
    {
        ArgumentNullException.ThrowIfNull(scaffold);
        ArgumentException.ThrowIfNullOrWhiteSpace(signallingUrl);
        ArgumentException.ThrowIfNullOrWhiteSpace(streamerId);

        var psi = BuildGameStartInfoCore(_install, scaffold, signallingUrl, streamerId, resX, resY, debugWindow, orbitImport);
        _log.Information(
            "ue game launch project={Project} level={Level} signallingUrl={SignallingUrl} streamerId={StreamerId} res={ResX}x{ResY} debugWindow={DebugWindow} connectorImport={ConnectorImport}",
            scaffold.UprojectPath, scaffold.LevelPath, signallingUrl, streamerId, resX, resY, debugWindow,
            orbitImport is null ? "off" : $"{orbitImport.Server}/{orbitImport.ProjectId}/{orbitImport.ModelId}");
        if (debugWindow)
        {
            _log.Warning(
                "ue game launch: DEBUG WINDOW enabled — launching UE -game WINDOWED (not -RenderOffScreen). " +
                "A visible UE window will only appear if this orchestrator (and the PRISM agent that spawned it) " +
                "runs in the operator's INTERACTIVE desktop session. When the agent runs as a Windows service " +
                "(session 0) the window is created on the hidden session-0 desktop and is NOT visible over RDP. " +
                "Pixel Streaming remains active either way.");
        }

        var process = new System.Diagnostics.Process { StartInfo = psi };

        // Channel mirrors Wilbur's line channel — `LaunchGameMode`'s
        // stdout / stderr go both to Serilog (existing behaviour) AND
        // to this channel so the Phase F streamer-connected watcher
        // can match against UE-side log shapes (the canonical
        // `LogPixelStreaming2EpicRtc: RoomSignallingContextObserver::OnJoined`
        // event lives only in UE's own log; Wilbur never emits it).
        // See REBUS-ORBIT/prism v0.3.9 for the regex set.
        var lineChannel = Channel.CreateUnbounded<string>(
            new UnboundedChannelOptions { SingleReader = false, SingleWriter = true });
        var ueChannel = _log.ForContext("channel", "ue-game");
        process.OutputDataReceived += (_, e) =>
        {
            var line = e.Data;
            if (line is null) return;
            ueChannel.Information("{Line}", line);
            lineChannel.Writer.TryWrite(line);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            var line = e.Data;
            if (line is null) return;
            ueChannel.Warning("{Line}", line);
            lineChannel.Writer.TryWrite(line);
        };
        process.Exited += (_, _) =>
        {
            try { lineChannel.Writer.TryComplete(); } catch { /* already completed */ }
        };
        process.EnableRaisingEvents = true;

        if (!process.Start())
        {
            throw new UnrealLaunchException(
                $"Failed to start UnrealEditor-Cmd.exe (-game mode) at '{_install.EditorCmdPath}'.");
        }

        try
        {
            _job.AddProcess(process.Id);
        }
        catch (Exception ex)
        {
            _log.Warning(ex,
                "ue game launch: failed to add UE pid={Pid} to JobObject; " +
                "KILL_ON_JOB_CLOSE will not cover it.", process.Id);
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        return new UnrealGameHandle(_log, process, streamerId, lineChannel);
    }

    /// <summary>
    /// Build the <see cref="ProcessStartInfo"/> the game-mode launcher
    /// uses. Public + static so tests can assert the argument string
    /// without spawning UE.
    /// </summary>
    public static ProcessStartInfo BuildGameStartInfoForTest(
        UnrealInstall install,
        ScaffoldResult scaffold,
        string signallingUrl,
        string streamerId,
        int resX = DefaultGameResX,
        int resY = DefaultGameResY,
        bool debugWindow = false,
        OrbitImportParams? orbitImport = null)
    {
        ArgumentNullException.ThrowIfNull(install);
        ArgumentNullException.ThrowIfNull(scaffold);
        return BuildGameStartInfoCore(install, scaffold, signallingUrl, streamerId, resX, resY, debugWindow, orbitImport);
    }

    private static ProcessStartInfo BuildGameStartInfoCore(
        UnrealInstall install,
        ScaffoldResult scaffold,
        string signallingUrl,
        string streamerId,
        int resX,
        int resY,
        bool debugWindow,
        OrbitImportParams? orbitImport = null)
    {
        var psi = new ProcessStartInfo
        {
            FileName = install.EditorCmdPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // Debug mode: don't suppress the child's own window. (UE's
            // Slate render window is created independently of this flag,
            // but leaving it false keeps behaviour intuitive when an
            // operator runs the orchestrator interactively.)
            CreateNoWindow = !debugWindow,
            WorkingDirectory = scaffold.ProjectRoot,
        };

        // Canonical UE 5.7 PixelStreaming 2 -game invocation (production / headless):
        //   UnrealEditor-Cmd.exe <project>.uproject <levelPath> -game \
        //     -RenderOffScreen -ResX=1920 -ResY=1080 \
        //     -PixelStreamingURL=ws://localhost:<port> \
        //     -PixelStreamingID=<streamerId> \
        //     -log -unattended
        //
        // PS2 (UE 5.5+) deprecated the legacy -PixelStreamingIP /
        // -PixelStreamingPort pair in favour of -PixelStreamingURL.
        // The plan §Risks calls this out and the UE 5.7 docs are
        // explicit: do NOT mix the two forms.
        //
        // DEBUG WINDOW mode (debugWindow == true): drop -RenderOffScreen
        // and -Unattended and request a real -windowed swapchain so a
        // visible UE window appears on PC01's interactive desktop. Pixel
        // Streaming is unaffected — it only needs the real GPU RHI (we
        // never pass -NullRHI here) plus -PixelStreamingURL/-ID, all of
        // which stay. -RenderOffScreen merely bypasses window
        // presentation; removing it lets the same rendered frames also
        // hit a window while still being captured by the PS2 encoder.
        // -Unattended is dropped too: it marks the run non-interactive
        // and can suppress the window / swallow on-screen prompts that
        // are useful while debugging.
        psi.ArgumentList.Add(scaffold.UprojectPath);
        // Open the per-run level explicitly when we know it (the Interchange
        // scaffolder always sets one). On the connector-import path the fixed
        // project may have no EditorStartupMap recorded — pass no map token so
        // UE boots the project's own GameDefaultMap instead of an empty arg.
        if (!string.IsNullOrWhiteSpace(scaffold.LevelPath))
        {
            psi.ArgumentList.Add(scaffold.LevelPath);
        }
        psi.ArgumentList.Add("-game");
        if (debugWindow)
        {
            psi.ArgumentList.Add("-windowed");
        }
        else
        {
            psi.ArgumentList.Add("-RenderOffScreen");
        }
        psi.ArgumentList.Add(string.Format(CultureInfo.InvariantCulture, "-ResX={0}", resX));
        psi.ArgumentList.Add(string.Format(CultureInfo.InvariantCulture, "-ResY={0}", resY));
        psi.ArgumentList.Add(string.Format(
            CultureInfo.InvariantCulture, "-PixelStreamingURL={0}", signallingUrl));
        psi.ArgumentList.Add(string.Format(
            CultureInfo.InvariantCulture, "-PixelStreamingID={0}", streamerId));
        if (!debugWindow)
        {
            psi.ArgumentList.Add("-Unattended");
        }
        psi.ArgumentList.Add("-NoSplash");
        psi.ArgumentList.Add("-NoPause");
        psi.ArgumentList.Add("-stdout");
        psi.ArgumentList.Add("-FullStdOutLogOutput");
        psi.ArgumentList.Add("-log");

        // Connector-import path: hand the ORBIT target to the bundled
        // OrbitConnector.UE5 plug-in. FOrbitHeadlessAutoImport reads these
        // -Orbit* tokens at module init and fires UOrbitImportSubsystem::
        // OrbitImport once the game world begins play, so the model is pulled
        // + loaded by the connector inside this same streamed UE instance
        // (no orchestrator-side glTF stage / Interchange python pass).
        if (orbitImport is not null)
        {
            psi.ArgumentList.Add(string.Format(
                CultureInfo.InvariantCulture, "-OrbitServer={0}", orbitImport.Server));
            psi.ArgumentList.Add(string.Format(
                CultureInfo.InvariantCulture, "-OrbitProject={0}", orbitImport.ProjectId));
            psi.ArgumentList.Add(string.Format(
                CultureInfo.InvariantCulture, "-OrbitModel={0}", orbitImport.ModelId));
            if (!string.IsNullOrWhiteSpace(orbitImport.VersionId))
            {
                psi.ArgumentList.Add(string.Format(
                    CultureInfo.InvariantCulture, "-OrbitVersion={0}", orbitImport.VersionId));
            }
            if (!string.IsNullOrWhiteSpace(orbitImport.Token))
            {
                psi.ArgumentList.Add(string.Format(
                    CultureInfo.InvariantCulture, "-OrbitToken={0}", orbitImport.Token));
            }
            if (!string.IsNullOrWhiteSpace(orbitImport.Target))
            {
                psi.ArgumentList.Add(string.Format(
                    CultureInfo.InvariantCulture, "-OrbitTarget={0}", orbitImport.Target));
            }
        }

        return psi;
    }

    // ----------------------------------------------------------------
    // Debug — FULL EDITOR launch (inspection-only)
    // ----------------------------------------------------------------

    /// <summary>
    /// Launch the FULL Unreal Editor GUI (<c>UnrealEditor.exe</c>, the
    /// Win32-GUI sibling of the <c>-Cmd</c> binary) against the already-
    /// scaffolded per-run project, opening directly into the imported map
    /// so the operator lands in the scene with the World Outliner /
    /// Details / Content Browser / viewport panels for debugging.
    ///
    /// <para>
    /// This is an INSPECTION-ONLY debug mode (the <c>FullEditor</c> debug
    /// option): unlike <see cref="LaunchGameMode"/> it brings up neither
    /// <c>-game</c> nor Pixel Streaming, so there is no browser stream —
    /// the operator inspects the editor directly on the workstation's
    /// interactive desktop. Streaming the editor would require launching
    /// Play-In-Editor with the Pixel Streaming plugin, which is out of
    /// scope for this debug path.
    /// </para>
    ///
    /// <para>
    /// Session-0 caveat (same as the game-window debug mode): the editor
    /// window only appears when the orchestrator (and the PRISM agent that
    /// spawned it) runs in the operator's INTERACTIVE desktop session. A
    /// process launched from a session-0 Windows service draws on the
    /// hidden session-0 desktop and is invisible over RDP.
    /// </para>
    /// </summary>
    public UnrealGameHandle LaunchFullEditor(ScaffoldResult scaffold)
    {
        ArgumentNullException.ThrowIfNull(scaffold);

        var psi = BuildFullEditorStartInfoCore(_install, scaffold);
        var editorExe = psi.FileName;
        if (!File.Exists(editorExe))
        {
            throw new UnrealLaunchException(
                $"Full editor binary not found at '{editorExe}'. Expected UnrealEditor.exe " +
                $"alongside UnrealEditor-Cmd.exe ('{_install.EditorCmdPath}').");
        }

        var mapPackage = ExtractMapPackagePath(scaffold.LevelPath);
        _log.Information(
            "ue FULL EDITOR launch editor={Editor} project={Project} map={Map}",
            editorExe, scaffold.UprojectPath, mapPackage);
        _log.Warning(
            "ue full-editor: opening the Unreal Editor GUI for inspection. The editor window " +
            "only appears on the operator's INTERACTIVE desktop session; when the agent runs as a " +
            "session-0 Windows service it is invisible. Pixel Streaming to the browser is NOT active " +
            "in full-editor mode (inspection only).");

        var process = new System.Diagnostics.Process { StartInfo = psi };

        var lineChannel = Channel.CreateUnbounded<string>(
            new UnboundedChannelOptions { SingleReader = false, SingleWriter = true });
        var ueChannel = _log.ForContext("channel", "ue-editor-gui");
        process.OutputDataReceived += (_, e) =>
        {
            var line = e.Data;
            if (line is null) return;
            ueChannel.Information("{Line}", line);
            lineChannel.Writer.TryWrite(line);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            var line = e.Data;
            if (line is null) return;
            ueChannel.Warning("{Line}", line);
            lineChannel.Writer.TryWrite(line);
        };
        process.Exited += (_, _) =>
        {
            try { lineChannel.Writer.TryComplete(); } catch { /* already completed */ }
        };
        process.EnableRaisingEvents = true;

        if (!process.Start())
        {
            throw new UnrealLaunchException(
                $"Failed to start UnrealEditor.exe (full editor) at '{editorExe}'.");
        }

        try
        {
            _job.AddProcess(process.Id);
        }
        catch (Exception ex)
        {
            _log.Warning(ex,
                "ue full-editor: failed to add UE pid={Pid} to JobObject; " +
                "KILL_ON_JOB_CLOSE will not cover it.", process.Id);
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        return new UnrealGameHandle(_log, process, "fulleditor", lineChannel);
    }

    /// <summary>
    /// Build the <see cref="ProcessStartInfo"/> the full-editor launcher
    /// uses. Public + static so tests can assert the argument string
    /// without spawning UE.
    /// </summary>
    public static ProcessStartInfo BuildFullEditorStartInfoForTest(
        UnrealInstall install, ScaffoldResult scaffold)
    {
        ArgumentNullException.ThrowIfNull(install);
        ArgumentNullException.ThrowIfNull(scaffold);
        return BuildFullEditorStartInfoCore(install, scaffold);
    }

    private static ProcessStartInfo BuildFullEditorStartInfoCore(
        UnrealInstall install, ScaffoldResult scaffold)
    {
        var editorExe = ResolveFullEditorExePath(install);
        var psi = new ProcessStartInfo
        {
            FileName = editorExe,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // Full IDE: don't suppress the window. UE creates its Slate
            // editor window regardless, but keep this false for clarity.
            CreateNoWindow = false,
            WorkingDirectory = scaffold.ProjectRoot,
        };

        // Canonical full-editor invocation:
        //   UnrealEditor.exe <project>.uproject <MapPackagePath> -log
        //
        // Passing the map's package path as the first positional token
        // after the project tells UE to LoadMap that level on startup, so
        // the operator lands directly in the imported scene. We pass the
        // PACKAGE path (/Game/REBUS/Maps/Imported_<runId>), not the object
        // path (…Imported_<runId>.Imported_<runId>) the streaming pass
        // uses, because the editor's startup-map arg expects the package.
        // No -game / -RenderOffScreen / -Unattended / -NullRHI: this is the
        // interactive IDE, not a headless or game-window run. -log opens
        // the separate UE log console which is handy while debugging.
        psi.ArgumentList.Add(scaffold.UprojectPath);
        psi.ArgumentList.Add(ExtractMapPackagePath(scaffold.LevelPath));
        psi.ArgumentList.Add("-log");

        return psi;
    }

    // ----------------------------------------------------------------
    // Debug — FULL EDITOR + PIXEL STREAMING (interactive + browser stream)
    // ----------------------------------------------------------------

    /// <summary>
    /// Launch the FULL Unreal Editor GUI (<c>UnrealEditor.exe</c>) against
    /// the scaffolded per-run project AND start the PixelStreaming2 EDITOR
    /// streamer so the level-editor viewport is streamed to the browser
    /// viewer at the same time. The operator drives the editor on the
    /// workstation's interactive desktop (full panels: World Outliner,
    /// Details, Content Browser, viewport gizmos) while remote viewers watch
    /// the streamed 3D viewport.
    ///
    /// <para>
    /// Reuses the exact same signalling bring-up as
    /// <see cref="LaunchGameMode"/>: the caller (see
    /// <see cref="PixelStreaming.PixelStreamingSession"/> /
    /// <c>VisualiserPipeline.StartStreamingAsync</c>) stands up Cirrus/Wilbur
    /// and allocates ports, then passes the streamer port URL + id here. The
    /// editor streamer registers with that signalling server exactly like
    /// the <c>-game</c> streamer, so the existing streamer-connected
    /// detection, ready event, and server/browser endpoints all work
    /// unchanged.
    /// </para>
    ///
    /// <para>
    /// Auto-start is driven by writing the editor-streamer settings into the
    /// project's <c>Config\DefaultGame.ini</c> (see
    /// <see cref="WriteEditorStreamingConfig"/>) — NOT via <c>-ExecCmds</c>,
    /// which fire too early to take effect. The PS2 settings class is
    /// <c>UCLASS(config = Game)</c>, so these are read at module init and the
    /// engine's own deferred hook (<c>OnMainFrameCreationFinished</c>) starts
    /// streaming once the editor window is up:
    /// <list type="bullet">
    ///   <item><description>
    ///     <c>EditorSource=LevelEditorViewport</c> — stream just the
    ///     level-editor 3D viewport (vs. <c>Editor</c> = the whole editor UI).
    ///   </description></item>
    ///   <item><description>
    ///     <c>EditorUseRemoteSignallingServer=True</c> — connect to OUR
    ///     Cirrus/Wilbur instead of spinning up the plugin's own embedded
    ///     signalling server (which the browser viewer wouldn't see).
    ///   </description></item>
    ///   <item><description>
    ///     <c>ConnectionURL=&lt;url&gt;</c> + <c>-PixelStreamingURL=&lt;url&gt;</c>
    ///     — point the streamer at the allocated streamer port.
    ///   </description></item>
    ///   <item><description>
    ///     <c>EditorStartOnLaunch=True</c> — engine auto-starts the editor
    ///     streamer from <c>OnMainFrameCreationFinished</c> (no toolbar click).
    ///   </description></item>
    /// </list>
    /// If auto-start ever fails to engage, the editor is still fully open and
    /// the operator can start streaming with one click from the Pixel Streaming
    /// toolbar (Stream Level Editor) — the rest of the pipeline then connects
    /// normally.
    /// </para>
    ///
    /// <para>
    /// Interactive: NO <c>-game</c> / <c>-RenderOffScreen</c> /
    /// <c>-Unattended</c> / <c>-NullRHI</c>. The editor needs a real RHI for
    /// the encoder anyway. Same session-0 caveat as the other debug modes —
    /// the editor window only appears in the operator's interactive session.
    /// </para>
    /// </summary>
    public UnrealGameHandle LaunchFullEditorStreaming(
        ScaffoldResult scaffold,
        string signallingUrl,
        string streamerId)
    {
        ArgumentNullException.ThrowIfNull(scaffold);
        ArgumentException.ThrowIfNullOrWhiteSpace(signallingUrl);
        ArgumentException.ThrowIfNullOrWhiteSpace(streamerId);

        // Persist the PS2 editor-streamer settings into the project's
        // Config\DefaultGame.ini BEFORE launch. This is the reliable
        // auto-start mechanism, and it is the ENGINE's own deferred trigger:
        //
        //   UPixelStreaming2PluginSettings is UCLASS(config = Game), so its
        //   EditorStartOnLaunch / EditorSource / EditorUseRemoteSignallingServer
        //   properties are read from DefaultGame.ini at module init. The PS2
        //   editor module then hooks IMainFrameModule::OnMainFrameCreationFinished
        //   (see Engine\Plugins\Media\PixelStreaming2 …\PixelStreaming2EditorModule.cpp
        //   InitEditorStreaming, ~L205) and, ONCE THE EDITOR MAIN WINDOW IS UP,
        //   checks CVarEditorStartOnLaunch and calls StartStreaming(CVarEditorSource)
        //   — the exact same call the "Stream Level Editor" toolbar button makes.
        //   That fires after the UI + viewport are initialised, which is why it
        //   works where the early `-ExecCmds` did not.
        //
        // Root cause of the earlier failure: we wrote these keys to
        // DefaultEngine.ini, but the settings class is config = Game, so the
        // values were never read (UE logged EditorStartOnLaunch=false "from
        // Property" at init) and the toolbar click was still required.
        WriteEditorStreamingConfig(ResolveDefaultGameIniPath(scaffold), signallingUrl);

        var psi = BuildFullEditorStreamingStartInfoCore(_install, scaffold, signallingUrl, streamerId);
        var editorExe = psi.FileName;
        if (!File.Exists(editorExe))
        {
            throw new UnrealLaunchException(
                $"Full editor binary not found at '{editorExe}'. Expected UnrealEditor.exe " +
                $"alongside UnrealEditor-Cmd.exe ('{_install.EditorCmdPath}').");
        }

        var mapPackage = ExtractMapPackagePath(scaffold.LevelPath);
        _log.Information(
            "ue FULL EDITOR + STREAM launch editor={Editor} project={Project} map={Map} signallingUrl={SignallingUrl} streamerId={StreamerId}",
            editorExe, scaffold.UprojectPath, mapPackage, signallingUrl, streamerId);
        _log.Warning(
            "ue full-editor-stream: opening the Unreal Editor GUI AND streaming the level-editor viewport. " +
            "The editor window only appears on the operator's INTERACTIVE desktop session (session-0 service = invisible). " +
            "The browser viewer receives the streamed viewport once the editor streamer registers.");

        var process = new System.Diagnostics.Process { StartInfo = psi };

        // Same line-channel wiring as LaunchGameMode: UE stdout/stderr feed
        // both Serilog and the channel the streamer-connected watcher reads
        // (the canonical RoomSignallingContextObserver::OnJoined line lives
        // only in UE's own log).
        var lineChannel = Channel.CreateUnbounded<string>(
            new UnboundedChannelOptions { SingleReader = false, SingleWriter = true });
        var ueChannel = _log.ForContext("channel", "ue-editor-stream");
        process.OutputDataReceived += (_, e) =>
        {
            var line = e.Data;
            if (line is null) return;
            ueChannel.Information("{Line}", line);
            lineChannel.Writer.TryWrite(line);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            var line = e.Data;
            if (line is null) return;
            ueChannel.Warning("{Line}", line);
            lineChannel.Writer.TryWrite(line);
        };
        process.Exited += (_, _) =>
        {
            try { lineChannel.Writer.TryComplete(); } catch { /* already completed */ }
        };
        process.EnableRaisingEvents = true;

        if (!process.Start())
        {
            throw new UnrealLaunchException(
                $"Failed to start UnrealEditor.exe (full editor + stream) at '{editorExe}'.");
        }

        try
        {
            _job.AddProcess(process.Id);
        }
        catch (Exception ex)
        {
            _log.Warning(ex,
                "ue full-editor-stream: failed to add UE pid={Pid} to JobObject; " +
                "KILL_ON_JOB_CLOSE will not cover it.", process.Id);
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        return new UnrealGameHandle(_log, process, streamerId, lineChannel);
    }

    /// <summary>
    /// Build the <see cref="ProcessStartInfo"/> the full-editor-streaming
    /// launcher uses. Public + static so tests can assert the argument
    /// string without spawning UE.
    /// </summary>
    public static ProcessStartInfo BuildFullEditorStreamingStartInfoForTest(
        UnrealInstall install, ScaffoldResult scaffold, string signallingUrl, string streamerId)
    {
        ArgumentNullException.ThrowIfNull(install);
        ArgumentNullException.ThrowIfNull(scaffold);
        return BuildFullEditorStreamingStartInfoCore(install, scaffold, signallingUrl, streamerId);
    }

    private static ProcessStartInfo BuildFullEditorStreamingStartInfoCore(
        UnrealInstall install, ScaffoldResult scaffold, string signallingUrl, string streamerId)
    {
        var editorExe = ResolveFullEditorExePath(install);
        var psi = new ProcessStartInfo
        {
            FileName = editorExe,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = false,
            WorkingDirectory = scaffold.ProjectRoot,
        };

        psi.ArgumentList.Add(scaffold.UprojectPath);
        // Open the level explicitly when we know it; otherwise let UE open the
        // project's own EditorStartupMap (the template baseline relies on this).
        if (!string.IsNullOrWhiteSpace(scaffold.LevelPath))
        {
            psi.ArgumentList.Add(ExtractMapPackagePath(scaffold.LevelPath));
        }

        // Point the streamer at OUR signalling server (the streamer port the
        // pipeline allocated + Cirrus/Wilbur is already listening on).
        // -PixelStreamingURL sets the streamer ConnectionURL (UE logs
        // "ConnectionURL … from command line"); -PixelStreamingID sets the
        // editor streamer id (InitEditorStreaming reads PixelStreamingID=).
        psi.ArgumentList.Add(string.Format(
            CultureInfo.InvariantCulture, "-PixelStreamingURL={0}", signallingUrl));
        psi.ArgumentList.Add(string.Format(
            CultureInfo.InvariantCulture, "-PixelStreamingID={0}", streamerId));

        // NOTE: we deliberately do NOT pass `-ExecCmds=PixelStreaming2.Editor.*`.
        // Those fire during early engine init — before the PS2 editor module
        // and the level-editor viewport exist — so they no-op (confirmed on
        // PC01: all four editor cvars stayed at their defaults at module init).
        // Auto-start is driven entirely by the DefaultGame.ini block written in
        // WriteEditorStreamingConfig, which the engine consumes at the correct
        // time via OnMainFrameCreationFinished.

        // Forward UE log to stdout so the streamer-connected watcher sees the
        // OnJoined line. NO -game / -RenderOffScreen / -Unattended: keep the
        // editor interactive and windowed on the operator's desktop.
        psi.ArgumentList.Add("-stdout");
        psi.ArgumentList.Add("-FullStdOutLogOutput");
        psi.ArgumentList.Add("-log");
        psi.ArgumentList.Add("-NoSplash");

        return psi;
    }

    // PRISM-managed block guards in DefaultGame.ini. We rewrite the block
    // on every launch so the per-run ConnectionURL (ws:// port) stays fresh
    // and the section never accumulates duplicates across runs.
    private const string EditorStreamCfgBegin = "; >>> PRISM auto-stream (managed) >>>";
    private const string EditorStreamCfgEnd   = "; <<< PRISM auto-stream (managed) <<<";

    /// <summary>
    /// Resolve the project's <c>Config\DefaultGame.ini</c> — the file
    /// <see cref="UPixelStreaming2PluginSettings"/> (UCLASS(config = Game))
    /// actually reads its editor-streamer properties from. Derived as the
    /// sibling of the scaffold's <c>DefaultEngine.ini</c> so it works for both
    /// the ORBIT scaffolder and the fixed-template provider.
    /// </summary>
    public static string ResolveDefaultGameIniPath(ScaffoldResult scaffold)
    {
        ArgumentNullException.ThrowIfNull(scaffold);
        var configDir = Path.GetDirectoryName(scaffold.DefaultEngineIniPath);
        if (string.IsNullOrEmpty(configDir))
        {
            // Fall back to <ProjectRoot>\Config when the ini path is unusual.
            configDir = Path.Combine(scaffold.ProjectRoot, "Config");
        }
        return Path.Combine(configDir, "DefaultGame.ini");
    }

    /// <summary>
    /// Write the confirmed PixelStreaming2 5.7 editor-streamer settings into
    /// the project's <c>Config/DefaultGame.ini</c> under
    /// <c>[/Script/PixelStreaming2Settings.PixelStreaming2PluginSettings]</c>.
    /// The settings class is <c>UCLASS(config = Game)</c>, so this is the file
    /// UE reads at module init (writing to <c>DefaultEngine.ini</c> is silently
    /// ignored). Config keys (verified against
    /// <c>UnrealEditor-PixelStreaming2Settings.dll</c> + the plugin headers):
    /// <list type="bullet">
    ///   <item><description><c>EditorSource=LevelEditorViewport</c> — stream the level-editor 3D viewport.</description></item>
    ///   <item><description><c>EditorStartOnLaunch=True</c> — engine auto-starts the editor streamer from OnMainFrameCreationFinished.</description></item>
    ///   <item><description><c>EditorUseRemoteSignallingServer=True</c> — connect to OUR Cirrus, not the plugin's embedded server.</description></item>
    ///   <item><description><c>ConnectionURL=ws://127.0.0.1:&lt;port&gt;</c> — the allocated streamer port.</description></item>
    /// </list>
    /// </summary>
    private void WriteEditorStreamingConfig(string iniPath, string signallingUrl)
    {
        try
        {
            var block = string.Join("\n", new[]
            {
                EditorStreamCfgBegin,
                "[/Script/PixelStreaming2Settings.PixelStreaming2PluginSettings]",
                "EditorSource=LevelEditorViewport",
                "EditorStartOnLaunch=True",
                "EditorUseRemoteSignallingServer=True",
                string.Format(CultureInfo.InvariantCulture, "ConnectionURL={0}", signallingUrl),
                EditorStreamCfgEnd,
            });

            var existing = File.Exists(iniPath) ? File.ReadAllText(iniPath) : string.Empty;
            existing = StripManagedBlock(existing);

            var sb = string.IsNullOrWhiteSpace(existing)
                ? block + "\n"
                : existing.TrimEnd() + "\n\n" + block + "\n";

            var dir = Path.GetDirectoryName(iniPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(iniPath, sb);
            _log.Information(
                "ue full-editor-stream: wrote PS2 editor-stream settings (Source=LevelEditorViewport, " +
                "StartOnLaunch, UseRemoteSignallingServer, ConnectionURL={Url}) to {Ini}",
                signallingUrl, iniPath);
        }
        catch (Exception ex)
        {
            // Non-fatal: the editor still opens and the operator can click
            // "Stream Level Editor" on the PS2 toolbar manually.
            _log.Warning(ex,
                "ue full-editor-stream: failed to write PS2 settings to {Ini}; " +
                "auto-start may not engage (manual toolbar click still works).", iniPath);
        }
    }

    private static string StripManagedBlock(string content)
    {
        if (string.IsNullOrEmpty(content)) return content;
        var begin = content.IndexOf(EditorStreamCfgBegin, StringComparison.Ordinal);
        if (begin < 0) return content;
        var endMarker = content.IndexOf(EditorStreamCfgEnd, begin, StringComparison.Ordinal);
        if (endMarker < 0) return content[..begin]; // truncated block — drop the tail
        var endOfLine = content.IndexOf('\n', endMarker);
        var cut = endOfLine < 0 ? content.Length : endOfLine + 1;
        return content[..begin] + content[cut..];
    }

    /// <summary>
    /// Resolve <c>UnrealEditor.exe</c> (the full GUI editor) as the sibling
    /// of the resolved <c>UnrealEditor-Cmd.exe</c> in the same
    /// <c>Engine\Binaries\Win64\</c> folder.
    /// </summary>
    public static string ResolveFullEditorExePath(UnrealInstall install)
    {
        ArgumentNullException.ThrowIfNull(install);
        var dir = Path.GetDirectoryName(install.EditorCmdPath);
        if (string.IsNullOrEmpty(dir))
        {
            throw new UnrealLaunchException(
                $"Cannot derive UnrealEditor.exe directory from '{install.EditorCmdPath}'.");
        }
        return Path.Combine(dir, "UnrealEditor.exe");
    }

    /// <summary>
    /// Strip the object-name suffix from a Speckle/UE level path so it can
    /// be passed as the editor's startup-map argument. The scaffolder
    /// produces an object path of the form
    /// <c>/Game/REBUS/Maps/Imported_&lt;runId&gt;.Imported_&lt;runId&gt;</c>;
    /// the editor wants the package path
    /// <c>/Game/REBUS/Maps/Imported_&lt;runId&gt;</c> (everything before
    /// the first dot). Returns the input unchanged when there is no dot.
    /// </summary>
    public static string ExtractMapPackagePath(string levelPath)
    {
        if (string.IsNullOrWhiteSpace(levelPath)) return levelPath;
        var dot = levelPath.IndexOf('.', StringComparison.Ordinal);
        return dot >= 0 ? levelPath[..dot] : levelPath;
    }

    // ----------------------------------------------------------------
    // Phase J — MVR / GDTF lighting import pass
    // ----------------------------------------------------------------

    /// <summary>Default name of the rendered MVR python script inside the scaffolded project.</summary>
    public const string MvrPythonRelativePath = @"Content\Python\import_mvr.py";

    /// <summary>Source name (in the orchestrator's exe folder) of the MVR template python.</summary>
    public const string MvrPythonTemplateAssetName = "import_mvr.py.in";

    /// <summary>
    /// Phase J — launch UE in <c>-run=PythonScript</c> mode against a
    /// rendered <c>import_mvr.py</c> that ingests the supplied MVR / GDTF
    /// staged files via the DMX plugin. Runs as a SECOND
    /// <c>UnrealEditor-Cmd.exe</c> pass after the Phase E
    /// <see cref="LaunchImportAsync"/> glTF import has finished. The two
    /// passes intentionally do not share an editor process — UE 5.7's
    /// Python entry point is one-shot, and re-using the same editor
    /// instance would require a Slate-backed plugin orchestrator we don't
    /// have today.
    ///
    /// <para>
    /// Renders the <c>import_mvr.py.in</c> template into the scaffold's
    /// <see cref="MvrPythonRelativePath"/>, substituting the JSON-encoded
    /// MVR + GDTF path arrays. The on-disk template is loaded once from
    /// the orchestrator's exe folder (where <c>import_mvr.py.in</c> is
    /// copied via the csproj's <c>None Include="..."</c> entries).
    /// </para>
    ///
    /// <para>
    /// Marker contract mirrors <see cref="LaunchImportAsync"/>'s but with
    /// the <c>PRISM_VISUALISER_MVR_*</c> prefixes — see
    /// <see cref="MvrReadyMarkerPrefix"/> / <see cref="MvrErrorMarkerPrefix"/>.
    /// </para>
    /// </summary>
    /// <param name="scaffold">
    ///   The same per-run scaffold the Phase E import ran against; the
    ///   MVR script writes its rendered copy into the project's
    ///   <c>Content\Python\</c> folder and reuses the same .uproject.
    /// </param>
    /// <param name="mvrPaths">
    ///   Absolute paths of staged <c>.mvr</c> files to import. May be empty
    ///   if only GDTF files were detected.
    /// </param>
    /// <param name="gdtfPaths">
    ///   Absolute paths of staged <c>.gdtf</c> files to import. The script
    ///   imports these first so MVR scenes can resolve their fixture refs.
    /// </param>
    /// <param name="timeout">
    ///   Wait budget for UE to emit a marker. Defaults to
    ///   <see cref="DefaultTimeout"/>.
    /// </param>
    /// <param name="ct">Cancellation token (forwarded to UE process kill).</param>
    public async Task<UnrealMvrImportResult> LaunchMvrImportAsync(
        ScaffoldResult scaffold,
        IReadOnlyList<string> mvrPaths,
        IReadOnlyList<string> gdtfPaths,
        TimeSpan? timeout = null,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(scaffold);
        ArgumentNullException.ThrowIfNull(mvrPaths);
        ArgumentNullException.ThrowIfNull(gdtfPaths);
        timeout ??= DefaultTimeout;

        var pythonPath = RenderMvrPythonScript(scaffold, mvrPaths, gdtfPaths);

        var psi = BuildMvrStartInfoCore(_install, scaffold, pythonPath);
        _log.Information(
            "ue mvr launch project={Project} python={Python} mvrCount={MvrCount} gdtfCount={GdtfCount} timeoutMs={TimeoutMs}",
            scaffold.UprojectPath, pythonPath, mvrPaths.Count, gdtfPaths.Count,
            (int)timeout.Value.TotalMilliseconds);

        using var process = new System.Diagnostics.Process { StartInfo = psi };
        var readyTcs = new TaskCompletionSource<UnrealMvrReadyMarker>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var errorTcs = new TaskCompletionSource<UnrealMvrErrorMarker>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        var ueChannel = _log.ForContext("channel", LogChannel);
        process.OutputDataReceived += (_, e) =>
        {
            var line = e.Data;
            if (line is null) return;
            ueChannel.Information("{Line}", line);
            TryConsumeMvrMarker(line, readyTcs, errorTcs);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            var line = e.Data;
            if (line is null) return;
            ueChannel.Warning("{Line}", line);
            TryConsumeMvrMarker(line, readyTcs, errorTcs);
        };

        var startedAt = DateTime.UtcNow;
        if (!process.Start())
        {
            throw new UnrealLaunchException(
                $"Failed to start UnrealEditor-Cmd.exe at '{_install.EditorCmdPath}' for MVR import.");
        }

        try
        {
            _job.AddProcess(process.Id);
        }
        catch (Exception ex)
        {
            _log.Warning(ex,
                "ue mvr launch: failed to add UE pid={Pid} to JobObject; KILL_ON_JOB_CLOSE will not cover it.",
                process.Id);
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout.Value);

        var exitTask = process.WaitForExitAsync(timeoutCts.Token);

        var winner = await Task.WhenAny(
            readyTcs.Task,
            errorTcs.Task,
            exitTask).ConfigureAwait(false);

        if (winner == readyTcs.Task)
        {
            var ready = await readyTcs.Task.ConfigureAwait(false);
            await WaitForExitOrKillAsync(process, timeout.Value, timeoutCts.Token).ConfigureAwait(false);
            var elapsed = DateTime.UtcNow - startedAt;
            _log.Information(
                "ue mvr import ready runId={RunId} gdtf={GdtfCount} mvr={MvrCount} elapsedMs={ElapsedMs}",
                ready.RunId, ready.GdtfCount, ready.MvrCount, (long)elapsed.TotalMilliseconds);
            return new UnrealMvrImportResult(
                Status: UnrealImportStatus.Ready,
                Marker: ready,
                ExitCode: SafeExitCode(process),
                ProcessId: process.Id,
                Elapsed: elapsed,
                Error: null);
        }

        if (winner == errorTcs.Task)
        {
            var err = await errorTcs.Task.ConfigureAwait(false);
            await WaitForExitOrKillAsync(process, timeout.Value, timeoutCts.Token).ConfigureAwait(false);
            var elapsed = DateTime.UtcNow - startedAt;
            _log.Error(
                "ue mvr import error code={Code} message={Message} elapsedMs={ElapsedMs}",
                err.Code, err.Message, (long)elapsed.TotalMilliseconds);
            return new UnrealMvrImportResult(
                Status: UnrealImportStatus.PythonError,
                Marker: null,
                ExitCode: SafeExitCode(process),
                ProcessId: process.Id,
                Elapsed: elapsed,
                Error: err);
        }

        if (winner == exitTask)
        {
            var elapsed = DateTime.UtcNow - startedAt;
            if (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                throw new UnrealLaunchTimeoutException(
                    $"UE MVR import did not emit a ready marker within {timeout.Value.TotalSeconds:F0}s.");
            }
            try
            {
                await exitTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                throw new UnrealLaunchTimeoutException(
                    $"UE MVR import did not emit a ready marker within {timeout.Value.TotalSeconds:F0}s.");
            }
            var exitCode = SafeExitCode(process);
            _log.Error(
                "ue mvr import exited without ready marker exit={Exit} elapsedMs={ElapsedMs}",
                exitCode, (long)elapsed.TotalMilliseconds);
            return new UnrealMvrImportResult(
                Status: UnrealImportStatus.NoMarker,
                Marker: null,
                ExitCode: exitCode,
                ProcessId: process.Id,
                Elapsed: elapsed,
                Error: null);
        }

        throw new InvalidOperationException("Unreachable: Task.WhenAny returned an unknown task in MVR launch.");
    }

    /// <summary>
    /// Render the <c>import_mvr.py.in</c> template into the scaffold and
    /// return the absolute path of the rendered script. Loads the
    /// template from the orchestrator's exe directory (matching how
    /// <see cref="ProjectScaffolder.CreateDefault"/> finds
    /// <c>import_orbit.py.in</c>).
    /// </summary>
    private string RenderMvrPythonScript(
        ScaffoldResult scaffold,
        IReadOnlyList<string> mvrPaths,
        IReadOnlyList<string> gdtfPaths)
    {
        var templatePath = Path.Combine(AppContext.BaseDirectory, MvrPythonTemplateAssetName);
        if (!File.Exists(templatePath))
        {
            throw new FileNotFoundException(
                $"MVR python template not found at '{templatePath}'. Expected the orchestrator " +
                $"build to copy '{MvrPythonTemplateAssetName}' to its output directory " +
                $"(see csproj <Content Include='Unreal\\PythonScripts\\{MvrPythonTemplateAssetName}'>).",
                templatePath);
        }
        var template = File.ReadAllText(templatePath);

        // Mirror ProjectScaffolder's runId sanitisation so RUN_ID stays
        // legal in any UE asset-name context the script might log it in.
        var runIdFromScaffold = ExtractRunIdFromLevelPath(scaffold.LevelPath);
        var sanitisedRunId = ProjectScaffolder.SanitiseRunId(runIdFromScaffold);
        var levelName = "Imported_" + sanitisedRunId;
        var targetFolder = "/Game/REBUS/Imported_" + sanitisedRunId + "/Lighting";

        var rendered = RenderMvrTemplate(
            template,
            sanitisedRunId,
            mvrPaths,
            gdtfPaths,
            targetFolder,
            levelName);

        var pythonPath = Path.Combine(scaffold.ProjectRoot, MvrPythonRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(pythonPath)!);
        File.WriteAllText(pythonPath, rendered,
            new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return pythonPath;
    }

    /// <summary>
    /// Render the MVR python template by replacing its <c>{{...}}</c>
    /// placeholders with the supplied per-run values. Public + static
    /// so tests can verify the substitutions in isolation without
    /// touching the file system.
    /// </summary>
    /// <remarks>
    /// The two path lists are JSON-encoded (one-line, no indent) so the
    /// rendered script can <c>json.loads</c> them safely regardless of
    /// backslash density. Path values themselves are never quoted into
    /// raw Python literals — every backslash and special char round-trips
    /// through the JSON parser.
    /// </remarks>
    public static string RenderMvrTemplate(
        string template,
        string runId,
        IReadOnlyList<string> mvrPaths,
        IReadOnlyList<string> gdtfPaths,
        string targetFolder,
        string levelName)
    {
        ArgumentNullException.ThrowIfNull(template);
        ArgumentException.ThrowIfNullOrWhiteSpace(runId);
        ArgumentNullException.ThrowIfNull(mvrPaths);
        ArgumentNullException.ThrowIfNull(gdtfPaths);
        ArgumentException.ThrowIfNullOrWhiteSpace(targetFolder);
        ArgumentException.ThrowIfNullOrWhiteSpace(levelName);

        var mvrJson = JsonSerializer.Serialize(
            mvrPaths, UnrealMvrPathsJsonContext.Default.IReadOnlyListString);
        var gdtfJson = JsonSerializer.Serialize(
            gdtfPaths, UnrealMvrPathsJsonContext.Default.IReadOnlyListString);

        // The template wraps each *_PATHS_JSON placeholder in a Python
        // raw triple-quoted string (r"""..."""), which round-trips JSON
        // safely as long as the payload doesn't contain three
        // consecutive double quotes. JSON-encoded file paths never do.
        return template
            .Replace("{{RUN_ID}}", runId, StringComparison.Ordinal)
            .Replace("{{MVR_PATHS_JSON}}", mvrJson, StringComparison.Ordinal)
            .Replace("{{GDTF_PATHS_JSON}}", gdtfJson, StringComparison.Ordinal)
            .Replace("{{TARGET_FOLDER}}", targetFolder, StringComparison.Ordinal)
            .Replace("{{LEVEL_NAME}}", levelName, StringComparison.Ordinal);
    }

    /// <summary>
    /// Build the <see cref="ProcessStartInfo"/> the MVR launcher uses.
    /// Public + static so tests can assert the argument string without
    /// spawning UE.
    /// </summary>
    public static ProcessStartInfo BuildMvrStartInfoForTest(
        UnrealInstall install, ScaffoldResult scaffold, string mvrPythonPath)
    {
        ArgumentNullException.ThrowIfNull(install);
        ArgumentNullException.ThrowIfNull(scaffold);
        return BuildMvrStartInfoCore(install, scaffold, mvrPythonPath);
    }

    private static ProcessStartInfo BuildMvrStartInfoCore(
        UnrealInstall install, ScaffoldResult scaffold, string mvrPythonPath)
    {
        var psi = new ProcessStartInfo
        {
            FileName = install.EditorCmdPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = scaffold.ProjectRoot,
        };
        // Same -script=<path> rationale as BuildStartInfoCore — see the
        // comment there for the full explanation of why
        // -ExecutePythonScript is rejected when -run=PythonScript puts
        // the editor into commandlet mode.
        psi.ArgumentList.Add(scaffold.UprojectPath);
        psi.ArgumentList.Add("-run=PythonScript");
        psi.ArgumentList.Add(string.Format(
            CultureInfo.InvariantCulture,
            "-script={0}", mvrPythonPath));
        psi.ArgumentList.Add("-Unattended");
        psi.ArgumentList.Add("-NoSplash");
        psi.ArgumentList.Add("-NoPause");
        psi.ArgumentList.Add("-NullRHI");
        psi.ArgumentList.Add("-stdout");
        psi.ArgumentList.Add("-FullStdOutLogOutput");
        return psi;
    }

    private static string ExtractRunIdFromLevelPath(string levelPath)
    {
        // Mirror the level-path format ProjectScaffolder produces:
        //   /Game/REBUS/Maps/Imported_<runId>.Imported_<runId>
        // The runId is between "Imported_" and the dot. Fallback to the
        // full string if the format ever drifts.
        if (string.IsNullOrEmpty(levelPath)) return "run";
        const string marker = "Imported_";
        var idx = levelPath.IndexOf(marker, StringComparison.Ordinal);
        if (idx < 0) return "run";
        var afterMarker = levelPath[(idx + marker.Length)..];
        var dot = afterMarker.IndexOf('.', StringComparison.Ordinal);
        return (dot >= 0 ? afterMarker[..dot] : afterMarker).Trim();
    }

    private static void TryConsumeMvrMarker(
        string line,
        TaskCompletionSource<UnrealMvrReadyMarker> readyTcs,
        TaskCompletionSource<UnrealMvrErrorMarker> errorTcs)
    {
        try
        {
            var parsed = ParseMvrLine(line);
            switch (parsed.Kind)
            {
                case MarkerKind.Ready:
                    readyTcs.TrySetResult(parsed.ReadyMarker!);
                    break;
                case MarkerKind.Error:
                    errorTcs.TrySetResult(parsed.ErrorMarker!);
                    break;
                case MarkerKind.None:
                default:
                    break;
            }
        }
        catch (UnrealLaunchException ex)
        {
            errorTcs.TrySetResult(new UnrealMvrErrorMarker("malformed_marker", ex.Message));
        }
    }

    /// <summary>
    /// Locate one of our marker prefixes anywhere within a UE stdout /
    /// stderr line and, if present, return the JSON payload that follows
    /// it (trimmed of trailing whitespace).
    ///
    /// <para>
    /// UE launches the editor with <c>-stdout -FullStdOutLogOutput</c>
    /// (see <see cref="BuildStartInfoCore"/>), which mirrors UE's full
    /// categorised log to stdout. Python <c>print(...)</c> calls under
    /// <c>PythonScriptCommandlet</c> are captured by UE and re-emitted
    /// with a leading timestamp + log channel header, e.g.:
    /// <code>
    ///   [2026.05.28-12.13.40:178][  0]LogPython: PRISM_VISUALISER_READY {...}
    /// </code>
    /// A column-zero <c>StartsWith</c> against
    /// <see cref="ReadyMarkerPrefix"/> never matches that shape, so the
    /// marker would be silently dropped and the orchestrator would
    /// time out / fall through to <c>ue_import_failed: UE exited without
    /// a ready marker</c>. Switching to <c>IndexOf</c> finds the prefix
    /// regardless of preceding <c>[ts][ch]LogPython:</c> noise.
    /// </para>
    ///
    /// <para>
    /// Trade-off: a hostile downstream string that embedded the marker
    /// substring mid-line could in principle spoof a marker. UE-side log
    /// lines never contain user-controlled JSON outside our own
    /// <c>print</c>s, and this scanner is only attached to UE child
    /// process stdout / stderr — not to anything user-facing — so the
    /// extra permissiveness is fine for the commandlet contract.
    /// </para>
    ///
    /// <para>
    /// See also <see href="https://github.com/REBUS-ORBIT/prism/issues/23">REBUS-ORBIT/prism#23</see>.
    /// </para>
    /// </summary>
    /// <returns>
    /// <c>true</c> if <paramref name="prefix"/> was found anywhere in
    /// <paramref name="line"/>; the JSON payload is returned via
    /// <paramref name="payload"/> with surrounding whitespace stripped.
    /// </returns>
    public static bool TryFindMarker(string line, string prefix, out string payload)
    {
        ArgumentNullException.ThrowIfNull(line);
        ArgumentException.ThrowIfNullOrEmpty(prefix);
        var idx = line.IndexOf(prefix, StringComparison.Ordinal);
        if (idx < 0)
        {
            payload = string.Empty;
            return false;
        }
        payload = line[(idx + prefix.Length)..].Trim();
        return true;
    }

    /// <summary>
    /// Parse one stdout / stderr line for an MVR-import marker. Public +
    /// static so tests can assert marker recognition without spawning UE.
    /// </summary>
    public static MvrMarkerParseResult ParseMvrLine(string line)
    {
        ArgumentNullException.ThrowIfNull(line);
        if (TryFindMarker(line, MvrReadyMarkerPrefix, out var readyJson))
        {
            try
            {
                var marker = JsonSerializer.Deserialize(
                    readyJson, UnrealMvrMarkerJsonContext.Default.UnrealMvrReadyMarker)
                    ?? throw new UnrealLaunchException(
                        $"Empty MVR ready-marker payload: '{line}'.");
                return MvrMarkerParseResult.Ready(marker);
            }
            catch (JsonException ex)
            {
                throw new UnrealLaunchException(
                    $"Malformed MVR ready-marker payload: '{line}'.", ex);
            }
        }
        if (TryFindMarker(line, MvrErrorMarkerPrefix, out var errorJson))
        {
            try
            {
                var marker = JsonSerializer.Deserialize(
                    errorJson, UnrealMvrMarkerJsonContext.Default.UnrealMvrErrorMarker)
                    ?? throw new UnrealLaunchException(
                        $"Empty MVR error-marker payload: '{line}'.");
                return MvrMarkerParseResult.Error(marker);
            }
            catch (JsonException ex)
            {
                throw new UnrealLaunchException(
                    $"Malformed MVR error-marker payload: '{line}'.", ex);
            }
        }
        return MvrMarkerParseResult.NoMarker();
    }

    /// <summary>
    /// Parse one stdout / stderr line. Public + static so tests can
    /// assert marker recognition without spawning UE.
    /// </summary>
    public static MarkerParseResult ParseLine(string line)
    {
        ArgumentNullException.ThrowIfNull(line);
        if (TryFindMarker(line, ReadyMarkerPrefix, out var readyJson))
        {
            try
            {
                var marker = JsonSerializer.Deserialize(
                    readyJson, UnrealMarkerJsonContext.Default.UnrealReadyMarker)
                    ?? throw new UnrealLaunchException(
                        $"Empty ready-marker payload: '{line}'.");
                return MarkerParseResult.Ready(marker);
            }
            catch (JsonException ex)
            {
                throw new UnrealLaunchException(
                    $"Malformed ready-marker payload: '{line}'.", ex);
            }
        }
        if (TryFindMarker(line, ErrorMarkerPrefix, out var errorJson))
        {
            try
            {
                var marker = JsonSerializer.Deserialize(
                    errorJson, UnrealMarkerJsonContext.Default.UnrealErrorMarker)
                    ?? throw new UnrealLaunchException(
                        $"Empty error-marker payload: '{line}'.");
                return MarkerParseResult.Error(marker);
            }
            catch (JsonException ex)
            {
                throw new UnrealLaunchException(
                    $"Malformed error-marker payload: '{line}'.", ex);
            }
        }
        return MarkerParseResult.NoMarker();
    }

    private static void TryConsumeMarker(
        string line,
        TaskCompletionSource<UnrealReadyMarker> readyTcs,
        TaskCompletionSource<UnrealErrorMarker> errorTcs)
    {
        try
        {
            var parsed = ParseLine(line);
            switch (parsed.Kind)
            {
                case MarkerKind.Ready:
                    readyTcs.TrySetResult(parsed.ReadyMarker!);
                    break;
                case MarkerKind.Error:
                    errorTcs.TrySetResult(parsed.ErrorMarker!);
                    break;
                case MarkerKind.None:
                default:
                    break;
            }
        }
        catch (UnrealLaunchException ex)
        {
            // A malformed marker still counts as an error; surface it
            // via the error TCS so the launcher returns deterministically.
            errorTcs.TrySetResult(new UnrealErrorMarker("malformed_marker", ex.Message));
        }
    }

    private static async Task WaitForExitOrKillAsync(
        System.Diagnostics.Process process, TimeSpan timeout, CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(Math.Min(30, timeout.TotalSeconds)));
            await process.WaitForExitAsync(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Editor sometimes hangs on shutdown — KILL_ON_JOB_CLOSE
            // will eventually catch it, but be assertive about cleanup.
            await KillProcessTreeAsync(process).ConfigureAwait(false);
        }
    }

    private static async Task KillProcessTreeAsync(System.Diagnostics.Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            using var killCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await process.WaitForExitAsync(killCts.Token).ConfigureAwait(false);
        }
        catch
        {
            // Best-effort — JobObject KILL_ON_JOB_CLOSE is the safety net.
        }
    }

    private static int SafeExitCode(System.Diagnostics.Process process)
    {
        try { return process.HasExited ? process.ExitCode : -1; }
        catch { return -1; }
    }
}

/// <summary>Outcome of a single launcher run.</summary>
public sealed record UnrealImportResult(
    UnrealImportStatus Status,
    UnrealReadyMarker? Marker,
    int ExitCode,
    int ProcessId,
    TimeSpan Elapsed,
    UnrealErrorMarker? Error);

public enum UnrealImportStatus
{
    Ready,
    PythonError,
    NoMarker,
}

/// <summary>JSON-bound payload of a <c>PRISM_VISUALISER_READY</c> line.</summary>
public sealed record UnrealReadyMarker(
    [property: JsonPropertyName("runId")] string RunId,
    [property: JsonPropertyName("levelPath")] string LevelPath,
    [property: JsonPropertyName("assetCount")] int AssetCount,
    [property: JsonPropertyName("importDurationMs")] int ImportDurationMs);

/// <summary>JSON-bound payload of a <c>PRISM_VISUALISER_ERROR</c> line.</summary>
public sealed record UnrealErrorMarker(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message);

/// <summary>One line of UE stdout, classified.</summary>
public sealed class MarkerParseResult
{
    public MarkerKind Kind { get; }
    public UnrealReadyMarker? ReadyMarker { get; }
    public UnrealErrorMarker? ErrorMarker { get; }

    private MarkerParseResult(MarkerKind kind, UnrealReadyMarker? ready, UnrealErrorMarker? error)
    {
        Kind = kind; ReadyMarker = ready; ErrorMarker = error;
    }
    public static MarkerParseResult NoMarker() => new(MarkerKind.None, null, null);
    public static MarkerParseResult Ready(UnrealReadyMarker m) => new(MarkerKind.Ready, m, null);
    public static MarkerParseResult Error(UnrealErrorMarker m) => new(MarkerKind.Error, null, m);
}

public enum MarkerKind { None, Ready, Error }

/// <summary>One line of UE stdout from an MVR-import run, classified.</summary>
public sealed class MvrMarkerParseResult
{
    public MarkerKind Kind { get; }
    public UnrealMvrReadyMarker? ReadyMarker { get; }
    public UnrealMvrErrorMarker? ErrorMarker { get; }

    private MvrMarkerParseResult(MarkerKind kind, UnrealMvrReadyMarker? ready, UnrealMvrErrorMarker? error)
    {
        Kind = kind; ReadyMarker = ready; ErrorMarker = error;
    }
    public static MvrMarkerParseResult NoMarker() => new(MarkerKind.None, null, null);
    public static MvrMarkerParseResult Ready(UnrealMvrReadyMarker m) => new(MarkerKind.Ready, m, null);
    public static MvrMarkerParseResult Error(UnrealMvrErrorMarker m) => new(MarkerKind.Error, null, m);
}

/// <summary>Source-generated JSON context for marker payloads.</summary>
[JsonSerializable(typeof(UnrealReadyMarker))]
[JsonSerializable(typeof(UnrealErrorMarker))]
internal sealed partial class UnrealMarkerJsonContext : JsonSerializerContext { }

/// <summary>Source-generated JSON context for the MVR path arrays.</summary>
/// <remarks>
/// IReadOnlyList&lt;string&gt; can't be a [JsonSerializable] attribute
/// target directly because of trim-analyzer quirks; the type alias
/// <see cref="IReadOnlyListString"/> declared via the property below
/// gives the source generator a concrete handle to bind against.
/// </remarks>
[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(IReadOnlyList<string>))]
[JsonSerializable(typeof(List<string>))]
[JsonSerializable(typeof(string[]))]
internal sealed partial class UnrealMvrPathsJsonContext : JsonSerializerContext { }

/// <summary>UE failed to start or returned a malformed marker.</summary>
public sealed class UnrealLaunchException : Exception
{
    public UnrealLaunchException(string message) : base(message) { }
    public UnrealLaunchException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>UE didn't emit a marker within the configured timeout.</summary>
public sealed class UnrealLaunchTimeoutException : Exception
{
    public UnrealLaunchTimeoutException(string message) : base(message) { }
}

/// <summary>JSON-bound payload of a <c>PRISM_VISUALISER_MVR_READY</c> line.</summary>
public sealed record UnrealMvrReadyMarker(
    [property: JsonPropertyName("runId")] string RunId,
    [property: JsonPropertyName("gdtfCount")] int GdtfCount,
    [property: JsonPropertyName("mvrCount")] int MvrCount,
    [property: JsonPropertyName("importDurationMs")] int ImportDurationMs);

/// <summary>JSON-bound payload of a <c>PRISM_VISUALISER_MVR_ERROR</c> line.</summary>
public sealed record UnrealMvrErrorMarker(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message);

/// <summary>Source-generated JSON context for MVR marker payloads.</summary>
[JsonSerializable(typeof(UnrealMvrReadyMarker))]
[JsonSerializable(typeof(UnrealMvrErrorMarker))]
internal sealed partial class UnrealMvrMarkerJsonContext : JsonSerializerContext { }

/// <summary>Outcome of a <see cref="UnrealLauncher.LaunchMvrImportAsync"/> run.</summary>
public sealed record UnrealMvrImportResult(
    UnrealImportStatus Status,
    UnrealMvrReadyMarker? Marker,
    int ExitCode,
    int ProcessId,
    TimeSpan Elapsed,
    UnrealMvrErrorMarker? Error);

/// <summary>
/// Handle to a running UE <c>-game</c> process. Phase F composes this
/// with a <see cref="PixelStreaming.SignallingHandle"/> in
/// <c>PixelStreamingSession</c>; the session waits for the
/// "Streamer connected" event on the Cirrus side before declaring the
/// run ready, and tears UE down before Cirrus on shutdown.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class UnrealGameHandle : IAsyncDisposable
{
    private readonly Serilog.ILogger _log;
    private readonly System.Diagnostics.Process _process;
    private readonly Channel<string>? _lineChannel;
    private bool _disposed;

    internal UnrealGameHandle(
        Serilog.ILogger log,
        System.Diagnostics.Process process,
        string streamerId,
        Channel<string>? lineChannel = null)
    {
        _log = log;
        _process = process;
        _lineChannel = lineChannel;
        StreamerId = streamerId;
    }

    /// <summary>Streamer id passed to UE on the command line.</summary>
    public string StreamerId { get; }

    /// <summary>
    /// Live stream of UE stdout / stderr lines, fed by the same handler
    /// that forwards lines to Serilog's <c>ue-game</c> channel.
    /// Consumed by the Phase F streamer-connected watcher so it can
    /// match against UE-side log shapes
    /// (<c>LogPixelStreaming2EpicRtc: RoomSignallingContextObserver::OnJoined</c>,
    /// <c>LogPixelStreaming2RTC: Player (orbit_...) joined</c>) that
    /// don't appear on Wilbur's own stdout. <see langword="null"/> when
    /// the handle was constructed without a line channel (test code
    /// that doesn't need stdout matching).
    /// </summary>
    public ChannelReader<string>? Lines => _lineChannel?.Reader;

    /// <summary>PID of the running UE child process.</summary>
    public int ProcessId => _process.Id;

    /// <summary>True if the child process has exited.</summary>
    public bool HasExited
    {
        get
        {
            try { return _process.HasExited; }
            catch { return true; }
        }
    }

    /// <summary>Latest reported exit code, or -1 if the process is still running.</summary>
    public int ExitCode
    {
        get
        {
            try { return _process.HasExited ? _process.ExitCode : -1; }
            catch { return -1; }
        }
    }

    /// <summary>Block until the UE process exits.</summary>
    public Task WaitForExitAsync(CancellationToken ct) =>
        _process.WaitForExitAsync(ct);

    /// <summary>Kill the UE process (process tree).</summary>
    public void Kill()
    {
        try
        {
            if (!_process.HasExited) _process.Kill(entireProcessTree: true);
        }
        catch (Exception ex)
        {
            _log.Warning(ex, "ue game kill failed pid={Pid}", _process.Id);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            Kill();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await _process.WaitForExitAsync(cts.Token).ConfigureAwait(false);
        }
        catch
        {
            // best-effort
        }
        finally
        {
            try { _lineChannel?.Writer.TryComplete(); } catch { /* already complete */ }
            _process.Dispose();
        }
    }
}
