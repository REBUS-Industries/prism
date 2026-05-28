using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.RegularExpressions;

using Serilog;

using PRISM.Visualiser.Orchestrator.Process;
using PRISM.Visualiser.Orchestrator.Unreal;

namespace PRISM.Visualiser.Orchestrator.PixelStreaming;

/// <summary>
/// First-run installer for the PixelStreaming 2 signalling server
/// ("Wilbur") that ships with UE 5.5+.
///
/// <para>
/// The PixelStreaming2 plugin ships its C++ runtime with every UE
/// launcher install, but the Node.js / TypeScript signalling pieces
/// are fetched on demand by the engine's helper script
/// <c>Engine\Plugins\Media\PixelStreaming2\Resources\WebServers\get_ps_servers.bat</c>.
/// Until that script has run at least once, the
/// <c>SignallingWebServer\</c> directory is empty (or missing),
/// <c>node.exe</c> hasn't been downloaded, and the wilbur TypeScript
/// hasn't been compiled to <c>dist\index.js</c>. <see cref="SignallingSupervisor.Resolve"/>
/// then returns <c>CirrusScriptPath = null</c> and Phase F fails with
/// <c>signalling_not_found</c>, requiring a manual install step from
/// the operator.
/// </para>
///
/// <para>
/// <see cref="EnsureReadyAsync"/> turns that into a one-shot
/// auto-install. The bootstrap is idempotent:
/// <list type="number">
///   <item><description>
///     If <c>SignallingWebServer\dist\index.js</c> already exists,
///     we're done — return <see cref="SignallingBootstrapStatus.AlreadyReady"/>.
///   </description></item>
///   <item><description>
///     Otherwise, invoke <c>get_ps_servers.bat /v 5.7</c> to clone the
///     EpicGamesExt/PixelStreamingInfrastructure UE5.7 branch into the
///     engine's WebServers directory.
///   </description></item>
///   <item><description>
///     Then invoke <c>SignallingWebServer\platform_scripts\cmd\start.bat</c>
///     with explicit loopback ports so it (a) downloads
///     <c>node.exe</c> into <c>platform_scripts\cmd\node\</c>, (b)
///     runs <c>npm install</c> across the workspace, (c) builds the
///     <c>Common</c>, <c>Signalling</c>, <c>Frontend</c>, and
///     <c>SignallingWebServer</c> TypeScript packages into their
///     <c>dist\</c> directories, and (d) starts wilbur on the
///     loopback ports we passed in. Once wilbur logs its first
///     listening line we kill the process tree — the build artifacts
///     it produced survive on disk.
///   </description></item>
///   <item><description>
///     Write a marker file under
///     <c>%LOCALAPPDATA%\PRISM.Visualiser\state\ue57_signalling_ready.flag</c>
///     containing the engine root + wilbur version so the next run
///     can short-circuit even before the disk probe.
///   </description></item>
/// </list>
/// </para>
///
/// <para>
/// The total bootstrap cost on a fresh PC01 install is roughly 1-3
/// minutes (Node.js download ~30 MB + npm packages ~150 MB + TSC
/// build). All stdout / stderr is forwarded to <see cref="ILogger"/>
/// under the channel <see cref="BootstrapLogChannel"/> so the agent
/// log captures the entire install transcript, including any
/// transient curl / npm errors.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SignallingBootstrap
{
    /// <summary>Serilog channel used for bootstrap process output.</summary>
    public const string BootstrapLogChannel = "ps-bootstrap";

    /// <summary>
    /// Path relative to the engine root of the get_ps_servers.bat
    /// helper. The script ships with the C++ plugin so this is always
    /// present on a launcher install that included PixelStreaming2.
    /// </summary>
    public const string GetPsServersRelative =
        @"Engine\Plugins\Media\PixelStreaming2\Resources\WebServers\get_ps_servers.bat";

    /// <summary>
    /// Path relative to the engine root of the wilbur build entrypoint
    /// (<c>dist\index.js</c>). Existence of this file is the canonical
    /// "bootstrap complete" signal.
    /// </summary>
    public const string WilburEntrypointRelative =
        @"Engine\Plugins\Media\PixelStreaming2\Resources\WebServers\SignallingWebServer\dist\index.js";

    /// <summary>
    /// Path relative to the engine root of the start.bat helper that
    /// downloads Node.js, runs <c>npm install</c>, compiles the
    /// TypeScript packages, and starts wilbur.
    /// </summary>
    public const string StartBatRelative =
        @"Engine\Plugins\Media\PixelStreaming2\Resources\WebServers\SignallingWebServer\platform_scripts\cmd\start.bat";

    /// <summary>
    /// Path relative to the engine root of the WebServers root
    /// (workspace root for <c>npm install</c>). Used as the cwd for
    /// <c>get_ps_servers.bat</c>.
    /// </summary>
    public const string WebServersRootRelative =
        @"Engine\Plugins\Media\PixelStreaming2\Resources\WebServers";

    /// <summary>
    /// Path relative to the engine root of the SignallingWebServer
    /// directory. Used as the cwd for <c>start.bat</c>.
    /// </summary>
    public const string SignallingWebServerRootRelative =
        @"Engine\Plugins\Media\PixelStreaming2\Resources\WebServers\SignallingWebServer";

    /// <summary>
    /// Loopback player port the bootstrap-time wilbur run binds to.
    /// Picked in the high-ephemeral range so it doesn't collide with
    /// typical workstation services. The bootstrap kills the wilbur
    /// process the moment it logs a ready line, so the port is only
    /// occupied for a few seconds.
    /// </summary>
    public const int BootstrapPlayerPort = 65000;

    /// <summary>Loopback streamer port the bootstrap-time wilbur run binds to.</summary>
    public const int BootstrapStreamerPort = 65001;

    /// <summary>
    /// Default budget for the entire bootstrap. The npm install + tsc
    /// pass on a fresh disk takes 60-180 s under normal conditions.
    /// </summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(8);

    /// <summary>Default budget for <c>get_ps_servers.bat</c> alone.</summary>
    public static readonly TimeSpan FetchTimeout = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Regex matching the first line wilbur logs once it starts
    /// listening. Permissive — wilbur prints multiple log shapes
    /// depending on <c>--log_config</c> / <c>--console_messages</c>.
    /// </summary>
    public static readonly Regex WilburReadyPattern = new(
        @"(?ix)
          ( wilbur \s+ v\d+(?:\.\d+)* \s+ starting
          | listening \s+ on (?:\s+ port)? [\s:]* \d+
          | server \s+ (?:started|listening) )",
        RegexOptions.Compiled);

    private readonly ILogger _log;
    private readonly JobObject _job;

    public SignallingBootstrap(ILogger log, JobObject job)
    {
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _job = job ?? throw new ArgumentNullException(nameof(job));
    }

    /// <summary>
    /// Resolve the default state directory under <c>%LOCALAPPDATA%</c>.
    /// Marker files for per-UE-install bootstrap state live here.
    /// </summary>
    public static string ResolveDefaultStateDirectory()
    {
        var local = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData,
            Environment.SpecialFolderOption.DoNotVerify);
        return Path.Combine(local, "PRISM.Visualiser", "state");
    }

    /// <summary>
    /// Marker file path for the given engine root. Existence is
    /// informational only — the canonical readiness check is the disk
    /// probe of <see cref="WilburEntrypointRelative"/>.
    /// </summary>
    public static string ResolveMarkerPath(string ueRoot, string? stateRoot = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(ueRoot);
        var dir = stateRoot ?? ResolveDefaultStateDirectory();
        // Hash the engine root so two parallel UE installs (e.g.
        // UE_5.6 + UE_5.7) don't share a marker.
        var slug = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(ueRoot.ToLowerInvariant())))
            .Substring(0, 12)
            .ToLowerInvariant();
        return Path.Combine(dir, $"signalling_ready_{slug}.flag");
    }

    /// <summary>
    /// Check whether the signalling server is ready to launch under
    /// the given UE root — i.e. wilbur's <c>dist\index.js</c> exists.
    /// Pure file-system probe; safe to call from anywhere without
    /// spawning processes.
    /// </summary>
    public static bool IsReady(string ueRoot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(ueRoot);
        var wilbur = Path.Combine(ueRoot, WilburEntrypointRelative);
        return File.Exists(wilbur);
    }

    /// <summary>
    /// Ensure the signalling server is installed + built under the
    /// given UE install. Returns synchronously when the bootstrap has
    /// already been run for this engine root.
    /// </summary>
    /// <exception cref="SignallingBootstrapException">
    ///   The bootstrap couldn't complete (missing get_ps_servers.bat,
    ///   network failure, npm / tsc failure, no listening line within
    ///   the timeout). The exception message names the failing stage
    ///   so the operator can take an informed manual action.
    /// </exception>
    public async Task<SignallingBootstrapResult> EnsureReadyAsync(
        UnrealInstall install,
        TimeSpan? timeout = null,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(install);
        var ueRoot = install.Root;
        var wilbur = Path.Combine(ueRoot, WilburEntrypointRelative);

        if (File.Exists(wilbur))
        {
            _log.Information(
                "signalling: bootstrap skipped (wilbur already built) path={Path}",
                wilbur);
            return new SignallingBootstrapResult(
                Status: SignallingBootstrapStatus.AlreadyReady,
                WilburEntrypointPath: wilbur,
                Elapsed: TimeSpan.Zero);
        }

        _log.Information(
            "signalling: bootstrapping (wilbur missing at {Path}) — this can take 1-3 minutes",
            wilbur);

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var budget = timeout ?? DefaultTimeout;
        using var bootstrapCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        bootstrapCts.CancelAfter(budget);

        try
        {
            // 1. Fetch sources via get_ps_servers.bat. Idempotent —
            //    skips if its DOWNLOAD_VERSION sidecar matches.
            await RunFetchScriptAsync(ueRoot, bootstrapCts.Token).ConfigureAwait(false);

            // 2. Build (and momentarily run) wilbur via start.bat.
            //    The script downloads Node.js, npm-installs the
            //    workspace, builds the TypeScript packages, and
            //    finally starts wilbur. We wait for the first
            //    listening line, then kill — the build artefacts
            //    survive the kill.
            await RunBuildAndProbeAsync(ueRoot, bootstrapCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (
            bootstrapCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            throw new SignallingBootstrapException(
                $"Bootstrap exceeded the {budget.TotalSeconds:F0}s budget. " +
                $"Inspect the bootstrap log lines (channel={BootstrapLogChannel}) " +
                $"for the failing stage. Engine root: {ueRoot}.");
        }

        if (!File.Exists(wilbur))
        {
            throw new SignallingBootstrapException(
                "Bootstrap finished but wilbur's dist/index.js is still " +
                $"missing at '{wilbur}'. The TypeScript build did not " +
                "produce the expected output — see the ps-bootstrap log " +
                "lines for the underlying npm / tsc error.");
        }

        // 3. Record success. The marker is informational; the disk
        //    probe above is the real source of truth.
        TryWriteMarker(ueRoot, wilbur, sw.Elapsed);

        sw.Stop();
        _log.Information(
            "signalling: ready after bootstrap elapsedMs={ElapsedMs} wilbur={Path}",
            (long)sw.Elapsed.TotalMilliseconds, wilbur);

        return new SignallingBootstrapResult(
            Status: SignallingBootstrapStatus.Bootstrapped,
            WilburEntrypointPath: wilbur,
            Elapsed: sw.Elapsed);
    }

    private async Task RunFetchScriptAsync(string ueRoot, CancellationToken ct)
    {
        var script = Path.Combine(ueRoot, GetPsServersRelative);
        if (!File.Exists(script))
        {
            throw new SignallingBootstrapException(
                $"get_ps_servers.bat not found at '{script}'. Either the " +
                "PixelStreaming2 plugin isn't installed under this UE " +
                "engine, or the install is incomplete. Re-install / verify " +
                "the engine via Epic Games Launcher.");
        }

        var workingDir = Path.Combine(ueRoot, WebServersRootRelative);
        _log.Information(
            "signalling: fetching ps-infra script={Script} cwd={Cwd}",
            script, workingDir);

        var stage = "get_ps_servers.bat";
        using var fetchCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        fetchCts.CancelAfter(FetchTimeout);

        var exit = await RunBatchAsync(
            script, "/v 5.7", workingDir, stage,
            killOnReadyMatch: false, fetchCts.Token).ConfigureAwait(false);

        if (exit != 0)
        {
            throw new SignallingBootstrapException(
                $"get_ps_servers.bat exited with code {exit}. The " +
                "ps-bootstrap log lines above carry the curl / tar " +
                "errors. Check this workstation's outbound connectivity " +
                "to github.com.");
        }
    }

    private async Task RunBuildAndProbeAsync(string ueRoot, CancellationToken ct)
    {
        var script = Path.Combine(ueRoot, StartBatRelative);
        if (!File.Exists(script))
        {
            throw new SignallingBootstrapException(
                $"start.bat not found at '{script}'. get_ps_servers.bat " +
                "reported success but the PixelStreaming infrastructure " +
                "archive didn't include the expected helper script.");
        }

        var workingDir = Path.Combine(ueRoot, SignallingWebServerRootRelative);
        var args = string.Format(
            System.Globalization.CultureInfo.InvariantCulture,
            "--publicip 127.0.0.1 -- " +
            "--player_port {0} --streamer_port {1} " +
            "--serve --console_messages verbose --log_config",
            BootstrapPlayerPort, BootstrapStreamerPort);

        _log.Information(
            "signalling: running start.bat for first-time build script={Script} args={Args} cwd={Cwd}",
            script, args, workingDir);

        var exit = await RunBatchAsync(
            script, args, workingDir, "start.bat",
            killOnReadyMatch: true, ct).ConfigureAwait(false);

        // Exit code is uninteresting on the kill path — wilbur was
        // forcibly terminated. What matters is whether dist/index.js
        // is now on disk; that's the post-condition the caller
        // verifies.
        _log.Information("signalling: start.bat exited code={Exit}", exit);
    }

    private async Task<int> RunBatchAsync(
        string script,
        string args,
        string workingDir,
        string stage,
        bool killOnReadyMatch,
        CancellationToken ct)
    {
        // Use cmd.exe /c so the .bat file's quoting / pushd /
        // setlocal semantics work the same as a manual invocation.
        var psi = new ProcessStartInfo
        {
            FileName = Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = workingDir,
        };
        psi.ArgumentList.Add("/c");
        psi.ArgumentList.Add(script);
        if (!string.IsNullOrWhiteSpace(args))
        {
            // start.bat parses its own flags, so we forward the
            // whole string unmodified — cmd.exe re-splits on spaces
            // and the script's setlocal / SHIFT loop handles it.
            foreach (var token in TokenizeArgs(args))
            {
                psi.ArgumentList.Add(token);
            }
        }

        var process = new System.Diagnostics.Process { StartInfo = psi };
        var ctx = _log.ForContext("channel", BootstrapLogChannel)
                       .ForContext("stage", stage);
        var readyMatched = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            ctx.Information("{Line}", e.Data);
            if (killOnReadyMatch
                && !readyMatched.Task.IsCompleted
                && WilburReadyPattern.IsMatch(e.Data))
            {
                readyMatched.TrySetResult(true);
            }
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            // npm + tsc routinely emit info text on stderr; surface
            // at Warning so it's visible without poisoning the
            // log at Error.
            ctx.Warning("{Line}", e.Data);
            if (killOnReadyMatch
                && !readyMatched.Task.IsCompleted
                && WilburReadyPattern.IsMatch(e.Data))
            {
                readyMatched.TrySetResult(true);
            }
        };
        process.EnableRaisingEvents = true;

        if (!process.Start())
        {
            throw new SignallingBootstrapException(
                $"Failed to start cmd.exe /c {script} for stage {stage}.");
        }

        try { _job.AddProcess(process.Id); }
        catch (Exception ex)
        {
            _log.Warning(ex,
                "signalling: failed to add bootstrap pid={Pid} to JobObject; " +
                "process-tree kill on agent exit not guaranteed.",
                process.Id);
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        if (killOnReadyMatch)
        {
            // Race the ready line against natural process exit and
            // cancellation. First match wins; we then kill the
            // entire tree (node.exe spawned by start.bat is a
            // grandchild of cmd.exe).
            var exitTask = process.WaitForExitAsync(ct);
            var winner = await Task.WhenAny(
                readyMatched.Task, exitTask).ConfigureAwait(false);

            if (winner == readyMatched.Task)
            {
                _log.Information(
                    "signalling: wilbur ready line observed during bootstrap " +
                    "stage={Stage} pid={Pid} — killing process tree to leave " +
                    "build artefacts on disk", stage, process.Id);
                await KillProcessTreeAsync(process).ConfigureAwait(false);
            }
            else
            {
                // Process exited without ever logging "ready". Either
                // the build failed (most likely) or wilbur self-
                // terminated. Surface the exit code so the caller can
                // decide; the post-condition check on dist/index.js
                // catches "exited 0 but didn't build anything" too.
                ctx.Warning(
                    "start.bat exited code={Exit} BEFORE wilbur logged a ready line",
                    process.ExitCode);
            }
        }
        else
        {
            await process.WaitForExitAsync(ct).ConfigureAwait(false);
        }

        int exit;
        try { exit = process.ExitCode; }
        catch { exit = -1; }
        process.Dispose();
        return exit;
    }

    private async Task KillProcessTreeAsync(System.Diagnostics.Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            using var killCts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await process.WaitForExitAsync(killCts.Token).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.Warning(ex,
                "signalling: bootstrap kill failed pid={Pid} — JobObject " +
                "KILL_ON_JOB_CLOSE will reclaim on agent exit",
                TryGetPid(process));
        }
    }

    private void TryWriteMarker(string ueRoot, string wilburPath, TimeSpan elapsed)
    {
        try
        {
            var markerPath = ResolveMarkerPath(ueRoot);
            Directory.CreateDirectory(
                Path.GetDirectoryName(markerPath)
                ?? ResolveDefaultStateDirectory());
            var body = string.Format(
                System.Globalization.CultureInfo.InvariantCulture,
                "ueRoot={0}\nwilbur={1}\nelapsedMs={2}\ntimestampUtc={3:O}\n",
                ueRoot, wilburPath, (long)elapsed.TotalMilliseconds, DateTime.UtcNow);
            File.WriteAllText(markerPath, body);
            _log.Information("signalling: marker written path={Path}", markerPath);
        }
        catch (Exception ex)
        {
            // Marker is informational; failing to write it never
            // fails the bootstrap. The next run probes the disk and
            // skips re-fetching if the artefacts are there.
            _log.Warning(ex, "signalling: failed to write bootstrap marker");
        }
    }

    private static int TryGetPid(System.Diagnostics.Process p)
    {
        try { return p.Id; }
        catch { return -1; }
    }

    /// <summary>
    /// Split a flat command-line string into tokens with simple
    /// quote-respecting rules. <c>cmd.exe</c> normally re-tokenises
    /// the string for us, but <see cref="ProcessStartInfo.ArgumentList"/>
    /// passes each entry through Windows' CommandLineToArgvW with its
    /// own escaping, so we want one ArgumentList entry per logical
    /// argument.
    /// </summary>
    public static IEnumerable<string> TokenizeArgs(string args)
    {
        if (string.IsNullOrWhiteSpace(args)) yield break;
        var buf = new System.Text.StringBuilder(args.Length);
        var inQuotes = false;
        foreach (var ch in args)
        {
            if (ch == '"')
            {
                inQuotes = !inQuotes;
                continue;
            }
            if (char.IsWhiteSpace(ch) && !inQuotes)
            {
                if (buf.Length > 0)
                {
                    yield return buf.ToString();
                    buf.Clear();
                }
                continue;
            }
            buf.Append(ch);
        }
        if (buf.Length > 0) yield return buf.ToString();
    }
}

/// <summary>Status of <see cref="SignallingBootstrap.EnsureReadyAsync"/>.</summary>
public enum SignallingBootstrapStatus
{
    /// <summary>The wilbur entrypoint already existed on disk; no work was done.</summary>
    AlreadyReady,

    /// <summary>The bootstrap downloaded + built the signalling stack.</summary>
    Bootstrapped,
}

/// <summary>Outcome of <see cref="SignallingBootstrap.EnsureReadyAsync"/>.</summary>
public sealed record SignallingBootstrapResult(
    SignallingBootstrapStatus Status,
    string WilburEntrypointPath,
    TimeSpan Elapsed);

/// <summary>
/// Bootstrap couldn't complete. Surfaced to the CLI as a
/// <c>signalling_bootstrap_failed</c> failed/v1 event so the operator
/// can see why their workstation needs manual remediation.
/// </summary>
public sealed class SignallingBootstrapException : Exception
{
    public SignallingBootstrapException(string message) : base(message) { }
    public SignallingBootstrapException(string message, Exception inner) : base(message, inner) { }
}
