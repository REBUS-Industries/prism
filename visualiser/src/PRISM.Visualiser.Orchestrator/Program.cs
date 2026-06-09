using System.CommandLine;
using System.CommandLine.Builder;
using System.CommandLine.Invocation;
using System.CommandLine.Parsing;
using System.Runtime.Versioning;

using PRISM.Visualiser.Orchestrator.Auth;
using PRISM.Visualiser.Orchestrator.Cache;
using PRISM.Visualiser.Orchestrator.Converters.FromOrbit;
using PRISM.Visualiser.Orchestrator.Ipc;
using PRISM.Visualiser.Orchestrator.Logging;
using PRISM.Visualiser.Orchestrator.Models;
using PRISM.Visualiser.Orchestrator.OrbitApi;
using PRISM.Visualiser.Orchestrator.Pipeline;
using PRISM.Visualiser.Orchestrator.PixelStreaming;
using PRISM.Visualiser.Orchestrator.Process;
using PRISM.Visualiser.Orchestrator.Staging;
using PRISM.Visualiser.Orchestrator.Unreal;

namespace PRISM.Visualiser.Orchestrator;

/// <summary>
/// CLI entrypoint. Two subcommands today:
///   stream  - launch a Pixel-Streaming session for one ORBIT version
///   cache   - cache management (prune, stat). Phase B only stubs `prune`.
///
/// All long-running work owns a Win32 Job Object created in Main, so
/// any future child process (Cirrus, UE) we spawn dies with us. The
/// JobObject is created BEFORE any subcommand handler runs so even an
/// `--unknown-flag` crash path stays clean.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class Program
{
    /// <summary>
    /// Process-lifetime Job Object. Intentionally kept as a static field
    /// (never disposed) because explicitly closing the handle triggers
    /// <c>KILL_ON_JOB_CLOSE</c>, which terminates this very process with
    /// the OS-default exit code 0 — destroying any non-zero exit code we
    /// were about to return. The Windows kernel reclaims the handle when
    /// the process exits, and at that point the job has no live
    /// processes left so <c>KILL_ON_JOB_CLOSE</c> only affects children.
    /// </summary>
    private static JobObject? _processJob;

    /// <summary>
    /// Environment variable that opts the <c>-game</c> streaming pass
    /// into a VISIBLE windowed UE process (equivalent to passing
    /// <c>--debug-window</c>). Lets an operator toggle the debug window
    /// on PC01 without rebuilding or changing the agent's CLI args.
    /// Truthy values: <c>1</c>, <c>true</c>, <c>yes</c>, <c>on</c>
    /// (case-insensitive). Anything else (or unset) keeps the default
    /// headless / off-screen behaviour.
    /// </summary>
    internal const string DebugWindowEnvVar = "PRISM_VISUALISER_DEBUG_WINDOW";

    /// <summary>
    /// True when <see cref="DebugWindowEnvVar"/> is set to a truthy
    /// value. Kept lenient so an operator setting <c>=1</c> or
    /// <c>=true</c> in a shell gets the same behaviour.
    /// </summary>
    private static bool DebugWindowEnvEnabled()
    {
        var raw = Environment.GetEnvironmentVariable(DebugWindowEnvVar);
        if (string.IsNullOrWhiteSpace(raw)) return false;
        return raw.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "yes" or "on" => true,
            _ => false,
        };
    }

    /// <summary>
    /// Environment variable that opts the streaming pass into launching the
    /// FULL Unreal Editor GUI (<c>UnrealEditor.exe</c>) against the imported
    /// map for visual inspection, instead of the headless / game-window
    /// streaming pass (equivalent to passing <c>--full-editor</c>). This is
    /// an inspection-only debug mode: no browser Pixel Streaming is brought
    /// up. When set (truthy) it SUPERSEDES the debug-window setting. Truthy
    /// values: <c>1</c>, <c>true</c>, <c>yes</c>, <c>on</c> (case-insensitive).
    /// </summary>
    internal const string FullEditorEnvVar = "PRISM_VISUALISER_FULL_EDITOR";

    /// <summary>
    /// True when <see cref="FullEditorEnvVar"/> is set to a truthy value.
    /// </summary>
    private static bool FullEditorEnvEnabled()
    {
        var raw = Environment.GetEnvironmentVariable(FullEditorEnvVar);
        if (string.IsNullOrWhiteSpace(raw)) return false;
        return raw.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "yes" or "on" => true,
            _ => false,
        };
    }

    /// <summary>
    /// Environment variable controlling whether the streaming pass imports the
    /// ORBIT model via the bundled <c>OrbitConnector.UE5</c> plug-in (the model
    /// is pulled + loaded inside the streamed UE instance at runtime) instead of
    /// the built-in Interchange importer (orchestrator stages glTF, UE editor
    /// runs <c>import_orbit.py</c>). Truthy enables the connector path,
    /// falsey forces the Interchange path. When UNSET the orchestrator
    /// auto-detects: it uses the connector when a fixed template project is
    /// configured (<see cref="TemplateProjectProvider.TemplateSourceEnvVar"/>)
    /// AND that project ships the connector plug-in + <c>orbit-cli</c>;
    /// otherwise it falls back to Interchange. Honoured via the
    /// <c>--connector-import</c> / <c>--no-connector-import</c> CLI flags too.
    /// </summary>
    internal const string ConnectorImportEnvVar = "PRISM_VISUALISER_CONNECTOR_IMPORT";

    /// <summary>
    /// Tri-state read of <see cref="ConnectorImportEnvVar"/>:
    /// <c>true</c> = force connector, <c>false</c> = force Interchange,
    /// <c>null</c> = unset (auto-detect).
    /// </summary>
    private static bool? ConnectorImportEnvValue()
    {
        var raw = Environment.GetEnvironmentVariable(ConnectorImportEnvVar);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return raw.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "yes" or "on" => true,
            "0" or "false" or "no" or "off" => false,
            _ => null,
        };
    }

    public static async Task<int> Main(string[] args)
    {
        _processJob = JobObject.CreateAndAssignSelf();

        // Belt-and-braces shutdown wiring. System.CommandLine's
        // CancelOnProcessTermination() already trips the
        // InvocationContext's CancellationToken on Ctrl+C / SIGTERM,
        // which is what RunPhaseFAsync awaits. Explicit hooks on
        // AppDomain.ProcessExit + Console.CancelKeyPress are
        // additional safety nets that flush stdout before the CLR
        // tears the process down — without them, the final
        // failed/v1 line can be truncated when the agent SIGTERMs us
        // mid-stream.
        Console.CancelKeyPress += static (_, e) =>
        {
            try { Console.Out.Flush(); } catch { /* best-effort */ }
            try { Console.Error.Flush(); } catch { /* best-effort */ }
            // Don't set e.Cancel — let System.CommandLine's
            // CancelOnProcessTermination unwind the handler
            // gracefully (it tracks the token internally).
        };
        AppDomain.CurrentDomain.ProcessExit += static (_, _) =>
        {
            try { Console.Out.Flush(); } catch { /* best-effort */ }
            try { Console.Error.Flush(); } catch { /* best-effort */ }
        };

        // System.CommandLine 2.0-beta4's default parser reports parse
        // errors via stderr but historically swallowed the resulting
        // exit code in some shells. Drive the parser explicitly so we
        // control both the error message and the exit code: any parse
        // error (unknown command, missing required option, bad enum
        // value) exits with code 64 — the BSD/sysexits convention for
        // EX_USAGE.
        var root = BuildRootCommand();
        var parser = new CommandLineBuilder(root)
            .UseHelp()
            .UseVersionOption()
            .UseTypoCorrections()
            .CancelOnProcessTermination()
            .Build();

        var parseResult = parser.Parse(args);
        if (parseResult.Errors.Count > 0)
        {
            foreach (var error in parseResult.Errors)
            {
                Console.Error.WriteLine($"error: {error.Message}");
            }
            Console.Error.WriteLine();
            Console.Error.WriteLine("Run with --help for usage.");
            return ExitCodes.Usage;
        }

        // If args parse cleanly but the user didn't pick a subcommand
        // (or picked the root command's --help / --version), help has
        // already printed. Make that flow obviously visible: we still
        // exit 0 for `--help`, but exit non-zero when the root command
        // is invoked with no actionable subcommand.
        if (parseResult.CommandResult.Command == root)
        {
            // --help / --version already wrote to stdout; bare invocation
            // (zero args) is a usage error.
            if (args.Length == 0)
            {
                Console.Error.WriteLine("error: a subcommand is required.");
                Console.Error.WriteLine();
                Console.Error.WriteLine("Run with --help for usage.");
                return ExitCodes.Usage;
            }
            return ExitCodes.Success;
        }

        return await parseResult.InvokeAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// Exit codes used by the orchestrator. Public so the agent and
    /// tests can reference them by name.
    ///
    /// <list type="table">
    ///   <listheader>
    ///     <term>Code</term><description>Meaning</description>
    ///   </listheader>
    ///   <item><term>0</term>  <description>Success (dry-run, or a real run that streamed and exited cleanly via Ctrl+C)</description></item>
    ///   <item><term>1</term>  <description>Generic runtime failure</description></item>
    ///   <item><term>4</term>  <description>UE root not found</description></item>
    ///   <item><term>5</term>  <description>UE import timed out</description></item>
    ///   <item><term>6</term>  <description>UE import failed (non-zero exit, or python error marker on stdout)</description></item>
    ///   <item><term>7</term>  <description>Cirrus signalling server failed to start within 30 s (Phase F)</description></item>
    ///   <item><term>8</term>  <description>UE -game failed to launch or never registered a streamer within 120 s (Phase F)</description></item>
    ///   <item><term>9</term>  <description>Reserved (was Phase F NotImplemented sentinel through v0.3.0; no longer emitted)</description></item>
    ///   <item><term>64</term> <description>EX_USAGE (parse errors)</description></item>
    /// </list>
    /// </summary>
    internal static class ExitCodes
    {
        public const int Success = 0;
        public const int Failure = 1;
        /// <summary>UE 5.7 install couldn't be located (Phase E).</summary>
        public const int UeRootNotFound = 4;
        /// <summary>UE didn't emit a ready marker within the budget (Phase E).</summary>
        public const int UeTimeout = 5;
        /// <summary>UE import failed (non-zero exit, python error marker) (Phase E).</summary>
        public const int UeImportFailed = 6;
        /// <summary>Cirrus didn't log a ready line within the budget (Phase F).</summary>
        public const int SignallingStartTimeout = 7;
        /// <summary>UE -game never registered a streamer / exited early (Phase F).</summary>
        public const int UeGameStartFailure = 8;
        /// <summary>
        /// Phase F NotImplemented sentinel from v0.3.0. Kept as a
        /// public constant for backwards compatibility with the
        /// agent's switch statement; the v0.4.0+ orchestrator no
        /// longer returns this — it goes all the way through to
        /// <see cref="Success"/> or a Phase-F-specific failure code.
        /// </summary>
        public const int NotImplemented = 9;
        /// <summary>BSD EX_USAGE — bad arguments / missing flags.</summary>
        public const int Usage = 64;
    }

    private static RootCommand BuildRootCommand()
    {
        var root = new RootCommand(
            "PRISM Visualiser orchestrator. Phase B scaffold — only --dry-run is functional.");

        root.AddCommand(BuildStreamCommand());
        root.AddCommand(BuildCacheCommand());
        return root;
    }

    // ------------------------------------------------------------
    // stream
    // ------------------------------------------------------------

    private static Command BuildStreamCommand()
    {
        var serverOption = new Option<string>(
            name: "--server",
            description: "ORBIT environment selector: prod | dev.")
        {
            IsRequired = true,
        }.FromAmong("prod", "dev");

        var projectOption = new Option<string>(
            name: "--project",
            description: "ORBIT project id.") { IsRequired = true };
        var modelOption = new Option<string>(
            name: "--model",
            description: "ORBIT model id.") { IsRequired = true };
        var versionOption = new Option<string?>(
            name: "--version",
            description: "ORBIT version id (resolved object root). Required for single-model imports; omit for tree imports.")
            { IsRequired = false };
        var runIdOption = new Option<string>(
            name: "--run-id",
            description: "Caller-supplied run UUID. Echoed in the ready event.")
            { IsRequired = true };
        var portHintOption = new Option<int>(
            name: "--signalling-port-hint",
            description: "Suggested local TCP port for Cirrus signalling. The orchestrator may pick a different one if the hint is in use.")
            { IsRequired = true };
        var jsonOption = new Option<bool>(
            name: "--json",
            description: "Required. Emits the ready event as a JSON line on stdout.");
        var dryRunOption = new Option<bool>(
            name: "--dry-run",
            description: "Skip fetch / import / spawn and emit a synthetic ready event.");
        var debugWindowOption = new Option<bool>(
            aliases: new[] { "--debug-window", "--no-headless" },
            description:
                "DEBUG: launch the -game streaming pass in a VISIBLE windowed UE process " +
                "(drops -RenderOffScreen/-Unattended, adds -windowed) instead of headless " +
                "off-screen rendering. Pixel Streaming stays active. Also honoured via the " +
                $"{DebugWindowEnvVar} environment variable. Default: headless (off).");
        var fullEditorOption = new Option<bool>(
            aliases: new[] { "--full-editor" },
            description:
                "DEBUG: open the FULL Unreal Editor GUI (UnrealEditor.exe) on the imported map " +
                "for visual inspection of the scene/actors/lighting/materials, instead of the " +
                "headless or game-window streaming pass. INSPECTION-ONLY: no browser Pixel " +
                "Streaming. SUPERSEDES --debug-window when both are set. Also honoured via the " +
                $"{FullEditorEnvVar} environment variable. Default: off.");
        var connectorImportOption = new Option<bool?>(
            name: "--connector-import",
            description:
                "Import the ORBIT model via the bundled OrbitConnector.UE5 plug-in (pulled + " +
                "loaded inside the streamed UE instance at runtime) instead of the built-in " +
                "Interchange importer. Pass '--connector-import true' to force it on, " +
                "'--connector-import false' to force the legacy Interchange path. Also honoured " +
                $"via the {ConnectorImportEnvVar} environment variable. When unset, auto-detects: " +
                "uses the connector when the fixed template project is configured AND ships the " +
                "connector plug-in + orbit-cli, else falls back to Interchange.");

        var modelNameOption = new Option<string?>(
            name: "--model-name",
            description: "ORBIT model name/path (e.g. 'building'). Required when --import-mode=tree.");

        var importModeOption = new Option<string>(
            name: "--import-mode",
            description: "Import mode: 'single' (default) or 'tree' (pull all submodels via OrbitImportTree).")
            .FromAmong("single", "tree");
        importModeOption.SetDefaultValue("single");

        var submodelIdsOption = new Option<string?>(
            name: "--submodel-ids",
            description:
                "Comma-separated list of ORBIT model IDs to import directly (tree mode). " +
                "When provided, the connector skips the orbit-cli models --under lookup and " +
                "imports exactly these submodel IDs, avoiding pagination issues where the " +
                "CLI default page size misses models beyond the first page.");

        var cmd = new Command("stream",
            "Launch a Pixel-Streaming session for an ORBIT model version.")
        {
            serverOption,
            projectOption,
            modelOption,
            versionOption,
            runIdOption,
            portHintOption,
            jsonOption,
            dryRunOption,
            debugWindowOption,
            fullEditorOption,
            connectorImportOption,
            modelNameOption,
            importModeOption,
            submodelIdsOption,
        };

        cmd.SetHandler(async (InvocationContext ctx) =>
        {
            var server = ctx.ParseResult.GetValueForOption(serverOption)!;
            var project = ctx.ParseResult.GetValueForOption(projectOption)!;
            var model = ctx.ParseResult.GetValueForOption(modelOption)!;
            var version = ctx.ParseResult.GetValueForOption(versionOption) ?? "";
            var runId = ctx.ParseResult.GetValueForOption(runIdOption)!;
            var portHint = ctx.ParseResult.GetValueForOption(portHintOption);
            var json = ctx.ParseResult.GetValueForOption(jsonOption);
            var dryRun = ctx.ParseResult.GetValueForOption(dryRunOption);
            var modelName = ctx.ParseResult.GetValueForOption(modelNameOption) ?? "";
            var importMode = ctx.ParseResult.GetValueForOption(importModeOption) ?? "single";
            var submodelIds = ctx.ParseResult.GetValueForOption(submodelIdsOption) ?? "";
            // Debug-window mode is opt-in via either the CLI flag or the
            // env var, so it can be toggled on PC01 without a rebuild.
            var debugWindow = ctx.ParseResult.GetValueForOption(debugWindowOption)
                || DebugWindowEnvEnabled();
            // Full-editor mode (inspection-only) is similarly opt-in and
            // SUPERSEDES debug-window when on.
            var fullEditor = ctx.ParseResult.GetValueForOption(fullEditorOption)
                || FullEditorEnvEnabled();
            // Connector-import is tri-state: CLI flag wins, else env var, else
            // null (auto-detect from the configured fixed project's plug-in).
            var connectorImport = ctx.ParseResult.GetValueForOption(connectorImportOption)
                ?? ConnectorImportEnvValue();

            if (!json)
            {
                Console.Error.WriteLine(
                    "[fatal] --json is required (the agent reads the ready event from stdout as JSON).");
                // ctx.ExitCode propagation through SetHandler is unreliable
                // in System.CommandLine 2.0-beta4 — Environment.Exit() is
                // the only way to guarantee the OS sees a non-zero code.
                ctx.ExitCode = ExitCodes.Usage;
                Environment.Exit(ExitCodes.Usage);
                return;
            }

            var (logger, logsDir) = StructuredLog.CreateRunLogger(runId);
            try
            {
                var manifest = new RunManifest(
                    RunId: runId,
                    ProjectId: project,
                    ModelId: model,
                    VersionId: version,
                    Server: ServerConfig.Resolve(server),
                    SignallingPortHint: portHint,
                    LogsDirectory: logsDir,
                    DryRun: dryRun,
                    ModelName: modelName,
                    ImportMode: importMode,
                    SubmodelIds: submodelIds);

                logger.Information(
                    "stream: server={Server} project={ProjectId} model={ModelId} version={VersionId} portHint={PortHint} dryRun={DryRun}",
                    manifest.Server.Name, manifest.ProjectId, manifest.ModelId,
                    manifest.VersionId, manifest.SignallingPortHint, manifest.DryRun);

                if (!dryRun)
                {
                    // NB: We intentionally do NOT call Environment.Exit here,
                    // even though some sibling paths in this handler do.
                    // RunPhaseFAsync's exit codes (0/1/4/5/6/7/8) must be
                    // propagated via ctx.ExitCode so the System.CommandLine
                    // parser returns them through Main. Calling
                    // Environment.Exit on this path deadlocks at process
                    // shutdown: the CLR's shutdown sequence races with the
                    // static JobObject/KillOnJobClose handle being finalised,
                    // and the async SetHandler state machine never unwinds.
                    var phaseFExit = await RunPhaseFAsync(
                            manifest, logger, debugWindow, fullEditor, connectorImport, ctx.GetCancellationToken())
                        .ConfigureAwait(false);
                    ctx.ExitCode = phaseFExit;
                    return;
                }

                // Cache root resolution is part of the dry run so any
                // pathing bug surfaces here instead of during a real
                // fetch.
                var cache = CacheRoot.ResolveDefault().EnsureCreated();
                logger.Information("cache={Cache}", cache);

                // Mimic some startup work so the agent observes the
                // expected "ready ~500ms after spawn" latency window.
                await Task.Delay(TimeSpan.FromMilliseconds(500))
                    .ConfigureAwait(false);

                // Synthesize plausible-but-clearly-fake values. The
                // 127.0.0.1:0 forms are intentional: they parse as
                // valid URIs but cannot collide with a real listener,
                // making them safe to surface in any agent-side
                // smoke test.
                var streamerId = $"orbit_{ShortId(runId)}";
                var ready = ReadyEvent.Ready(
                    runId: runId,
                    projectId: project,
                    modelId: model,
                    versionId: version,
                    playerUrl: "http://127.0.0.1:0/",
                    signallingUrl: "ws://127.0.0.1:0/",
                    streamerId: streamerId,
                    ueProcessId: 0,
                    signallingProcessId: 0,
                    logsDir: logsDir);

                ReadyHandshake.Write(ready);
                logger.Information("dry-run ready event emitted streamerId={StreamerId}",
                    streamerId);
                ctx.ExitCode = ExitCodes.Success;
            }
            catch (Exception ex)
            {
                logger.Error(ex, "stream failed");
                try
                {
                    ReadyHandshake.Write(ReadyEvent.Failed(
                        runId, project, model, version, logsDir,
                        ex.Message));
                }
                catch
                {
                    // stdout may be closed — nothing more we can do.
                }
                FlushLogger(logger);
                ctx.ExitCode = ExitCodes.Failure;
                Environment.Exit(ExitCodes.Failure);
            }
            finally
            {
                FlushLogger(logger);
            }
        });

        return cmd;
    }

    // ------------------------------------------------------------
    // cache prune
    // ------------------------------------------------------------

    private static Command BuildCacheCommand()
    {
        var cache = new Command("cache",
            "Cache management. Phase B stubs `prune`; real eviction lands in Phase C.");

        var olderThanOption = new Option<string>(
            name: "--older-than",
            description: "Drop cache entries last accessed before <duration> ago. ISO 8601-ish (e.g. 14d, 12h, 30m).")
            { IsRequired = true };

        var prune = new Command("prune", "Evict cache entries older than the given duration.")
        {
            olderThanOption,
        };
        prune.SetHandler((string olderThan) =>
        {
            var (logger, _) = StructuredLog.CreateRunLogger($"cache-prune-{DateTime.UtcNow:yyyyMMddHHmmss}");
            try
            {
                var root = CacheRoot.ResolveDefault();
                logger.Information(
                    "cache prune (stub) olderThan={OlderThan} cache={Cache}",
                    olderThan, root);
                Console.Error.WriteLine(
                    $"[stub] cache prune olderThan={olderThan}; no entries evicted.");
            }
            finally
            {
                FlushLogger(logger);
            }
        }, olderThanOption);

        cache.AddCommand(prune);
        return cache;
    }

    private static string ShortId(string runId)
    {
        var trimmed = runId.Replace("-", string.Empty, StringComparison.Ordinal);
        return trimmed.Length >= 8 ? trimmed[..8] : trimmed;
    }

    /// <summary>
    /// Phase F end-to-end run: auth → receive → glTF stage → resolve UE
    /// install → fetch template → scaffold → launch UE editor for
    /// import → bring up Cirrus + UE -game → emit
    /// <c>prism-visualiser/ready/v1</c> → block until UE exits or
    /// external cancellation, then tear UE+Cirrus down cleanly.
    /// Returns the exit code the caller propagates.
    ///
    /// <para>
    /// stdout sequence on the happy path:
    /// <list type="number">
    ///   <item><description><c>prism-visualiser/staged/v1</c> (Phase C)</description></item>
    ///   <item><description><c>prism-visualiser/imported/v1</c> (Phase E)</description></item>
    ///   <item><description><c>prism-visualiser/ready/v1</c> (Phase F)</description></item>
    /// </list>
    /// On failure, a <c>prism-visualiser/failed/v1</c> line is the
    /// last stdout event and the matching exit code is returned.
    /// </para>
    /// </summary>
    private static async Task<int> RunPhaseFAsync(
        RunManifest manifest, Serilog.ILogger logger, bool debugWindow, bool fullEditor,
        bool? connectorImport, CancellationToken ct)
    {
        // 1. Resolve UE install BEFORE running the (slow) receive
        //    pipeline. If UNREAL_ENGINE_ROOT is set but invalid, we
        //    want to fail fast with a typed event — not after spending
        //    minutes downloading the version's blobs.
        //
        //    ResolveDetailed (rather than TryResolve) returns a per-probe
        //    outcome list. On failure we fold that into the user-visible
        //    failure message so the operator can see at a glance which
        //    probe missed and why — "env var pointed at <X>, directory
        //    does not exist" beats the historical opaque "env var is set
        //    but invalid" string. Each diagnostic also lands in the
        //    Serilog file, so the per-run orchestrator.log keeps a full
        //    trace even when the agent only forwards the summary.
        var resolution = UnrealEnvironment.ResolveDetailed();
        foreach (var probe in resolution.Diagnostics)
        {
            if (probe.Install is not null)
            {
                logger.Information(
                    "ue env probe: source={Source} root={Root} matched",
                    probe.Source, probe.Install.Root);
            }
            else
            {
                logger.Warning(
                    "ue env probe: source={Source} raw={Raw} normalized={Normalized} dirExists={DirExists} editorExists={EditorExists} reason={Reason}",
                    probe.Source,
                    probe.RawRoot ?? "<unset>",
                    probe.NormalizedRoot ?? "<unset>",
                    probe.DirectoryExists,
                    probe.EditorExists,
                    probe.FailureReason ?? "(no reason)");
            }
        }
        var install = resolution.Install;
        if (install is null)
        {
            var msg = FormatUeRootFailure(resolution);
            logger.Error("ue env: {Message}", msg);
            EmitFailedEvent(manifest.RunId, FailedEvent.CodeUeRootNotFound, msg);
            return ExitCodes.UeRootNotFound;
        }
        logger.Information(
            "ue env: root={Root} editor={Editor} source={Source}",
            install.Root, install.EditorCmdPath, install.Source);

        // 2. Compose the pipeline. The pipeline owns the auth chain,
        //    the template fetcher, the scaffolder, and the JobObject
        //    every UE / Cirrus child process is added to.
        var tokenSource = CompositeOrbitTokenSource.Default();
        var fetcher = TemplateFetcher.CreateDefault(logger);
        var scaffolder = ProjectScaffolder.CreateDefault(logger);
        var pipeline = new VisualiserPipeline(
            tokenSource, fetcher, scaffolder, _processJob!, logger,
            debugWindow: debugWindow);
        if (fullEditor)
        {
            logger.Warning(
                "full-editor mode ENABLED ({EnvVar}/--full-editor): opening the FIXED connector-bearing project " +
                "({TemplateSource}) in the FULL Unreal Editor GUI AND auto-streaming the level-editor " +
                "viewport to the browser viewer (SUPERSEDES debug-window). Runs the SAME plug-in pipeline as the " +
                "headless -game connector-import path: the bundled OrbitConnector pulls + loads the ORBIT model " +
                "into the editor world and the Portal plug-in connects, so the operator can debug the LIVE scene " +
                "by hand. The orchestrator-side receive/stage/Interchange-python import is BYPASSED (the connector " +
                "imports inside UE). The editor window is only visible if this orchestrator runs in the operator's " +
                "interactive desktop session (NOT when the PRISM agent runs as a session-0 Windows service).",
                FullEditorEnvVar, TemplateProjectProvider.ResolveSource());
        }
        else if (debugWindow)
        {
            logger.Warning(
                "debug-window mode ENABLED ({EnvVar}/--debug-window): UE -game will run WINDOWED. " +
                "The window is only visible if this orchestrator runs in the operator's interactive " +
                "desktop session (NOT when the PRISM agent runs as a session-0 Windows service).",
                DebugWindowEnvVar);
        }

        // 3+4. Resolve the project to stream.
        //   - Full-editor baseline: BYPASS ORBIT receive/stage/import and
        //     copy the fixed template project (REBUS_TEMPLATE) locally.
        //   - Connector-import: copy the fixed project locally and let the
        //     bundled OrbitConnector.UE5 plug-in pull + load the model at
        //     runtime inside the streamed -game instance (no orchestrator-side
        //     glTF stage / Interchange python pass).
        //   - Interchange (legacy fallback): receive + stage + UE editor import.
        ScaffoldResult scaffold;
        // ORBIT session identity, forwarded to UE on EVERY launch path so any
        // plugin/module (the Portal plugin, etc.) can read the project / model
        // / version IDs as the UE-native shared variable
        // (-OrbitProject= / -OrbitModel= / -OrbitVersion=, read via FParse).
        // These are NOT secret. The bearer token is added ONLY on the
        // connector-import path below (see `with { Token = … }`): that path's
        // FOrbitHeadlessAutoImport needs it to pull the model, and other paths
        // neither have nor need it (so no secret leaks where it isn't used).
        OrbitImportParams orbitImport = new(
            Server: manifest.Server.BaseUrl,
            ProjectId: manifest.ProjectId,
            ModelId: manifest.ModelId,
            VersionId: manifest.VersionId,
            Token: string.Empty,
            Target: manifest.Server.Name,
            ModelName: manifest.ModelName,
            ImportMode: manifest.ImportMode,
            SubmodelIds: manifest.SubmodelIds);
        if (fullEditor)
        {
            // Full-editor mode now runs the SAME plug-in pipeline as the headless
            // -game connector-import path: prepare the FIXED connector-bearing
            // project (the same provider the connector path uses) AND hand the
            // connector the bearer token so FOrbitHeadlessAutoImport pulls + loads
            // the model into the editor world (and the Portal plug-in connects)
            // exactly as in -game. That is what lets the operator debug the LIVE
            // scene by hand in the editor instead of a bare template.
            try
            {
                scaffold = await pipeline
                    .PrepareTemplateProjectAsync(manifest, ct)
                    .ConfigureAwait(false);
            }
            catch (TemplateProjectException ex)
            {
                logger.Error(ex, "full-editor template prepare failed");
                EmitFailedEvent(manifest.RunId, FailedEvent.CodeScaffoldFailed, ex.Message);
                EmitFailedReady(manifest, ex.Message);
                return ExitCodes.Failure;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                logger.Information("full-editor template prepare cancelled");
                return ExitCodes.Success;
            }
            catch (Exception ex)
            {
                logger.Error(ex, "full-editor template prepare failed");
                EmitFailedEvent(manifest.RunId, FailedEvent.CodeScaffoldFailed, ex.Message);
                EmitFailedReady(manifest, ex.Message);
                return ExitCodes.Failure;
            }

            // Attach the bearer token + emit the connector-import event when a
            // model is actually targeted (and connector-import is not force-off),
            // so the bundled OrbitConnector auto-imports it into the editor world.
            // With no model targeted (or the connector forced off) we leave the
            // BARE fixed template — token stays empty — i.e. a plain editor open.
            var fullEditorHasModel = !string.IsNullOrWhiteSpace(manifest.ModelId);
            if (fullEditorHasModel && connectorImport != false)
            {
                var detection = OrbitConnectorLocator.Detect(scaffold.ProjectRoot);
                if (!detection.IsUsable)
                {
                    logger.Warning(
                        "full-editor connector-import: the fixed project '{Root}' does not fully ship the " +
                        "OrbitConnector plug-in ({Reason}); the editor will still open, but the model auto-import " +
                        "will NOT run until the connector + orbit-cli are present (re-pull the template+connector).",
                        scaffold.ProjectRoot, detection.Reason ?? "not usable");
                }
                var token = await pipeline.ResolveOrbitTokenAsync(manifest, ct).ConfigureAwait(false);
                // Add the bearer token to the identity so the connector's auto-
                // import can pull + load the model inside the full editor.
                orbitImport = orbitImport with { Token = token };
                EmitConnectorImportEvent(manifest, scaffold.ProjectRoot);
                logger.Information(
                    "full-editor connector-import: opening fixed project root={Root} level={Level} in the FULL editor; " +
                    "OrbitConnector will pull server={Server} project={Project} model={Model} version={Version} into the editor world",
                    scaffold.ProjectRoot,
                    string.IsNullOrEmpty(scaffold.LevelPath) ? "(project startup map)" : scaffold.LevelPath,
                    manifest.Server.Name, manifest.ProjectId, manifest.ModelId, manifest.VersionId);
            }
            else
            {
                logger.Warning(
                    "full-editor: opening the BARE fixed template (no model targeted{Reason}); no connector auto-import will run.",
                    connectorImport == false ? " / connector-import forced off" : string.Empty);
            }
            logger.Information(
                "full-editor template ready runId={RunId} project={Project} root={Root} level={Level}",
                manifest.RunId, scaffold.UprojectPath, scaffold.ProjectRoot,
                string.IsNullOrEmpty(scaffold.LevelPath) ? "(project startup map)" : scaffold.LevelPath);
        }
        else if (await TryPrepareConnectorImportAsync(
                     pipeline, manifest, connectorImport, logger, ct) is { } connectorScaffold)
        {
            // Connector-import path: the fixed visualiser project (with the
            // OrbitConnector.UE5 plug-in) was prepared locally. The model is
            // pulled + loaded by the connector at runtime inside the streamed
            // -game instance — no glTF stage / Interchange python pass here.
            scaffold = connectorScaffold;
            var token = await pipeline.ResolveOrbitTokenAsync(manifest, ct).ConfigureAwait(false);
            // Add the bearer token to the identity built above so the
            // connector's headless auto-import can pull + load the model.
            orbitImport = orbitImport with { Token = token };
            logger.Information(
                "connector-import: streaming fixed project root={Root} level={Level}; " +
                "OrbitConnector will pull server={Server} project={Project} model={Model} version={Version} at runtime",
                scaffold.ProjectRoot,
                string.IsNullOrEmpty(scaffold.LevelPath) ? "(project startup map)" : scaffold.LevelPath,
                manifest.Server.Name, manifest.ProjectId, manifest.ModelId, manifest.VersionId);

            // Informational progress event for the agent log (schema is logged,
            // not part of the agent<->server contract — the agent forwards only
            // ready/failed). Mirrors the staged/v1 emission on the legacy path
            // so operators see the import mechanism that was chosen.
            EmitConnectorImportEvent(manifest, scaffold.ProjectRoot);
        }
        else
        {
            // 3. Receive + stage. Emits the staged/v1 event so the agent
            //    has progress visibility even if UE later fails.
            StageOutcome stage;
            try
            {
                stage = await pipeline.ReceiveAndStageAsync(manifest, ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.Error(ex, "receive+stage failed");
                EmitFailedEvent(manifest.RunId, FailedEvent.CodeScaffoldFailed, ex.Message);
                return ExitCodes.Failure;
            }

            Console.Out.Write(stage.StagedEvent.ToJsonLine());
            Console.Out.Write('\n');
            Console.Out.Flush();
            logger.Information(
                "staged event emitted runId={RunId} stagePath={StagePath} meshCount={MeshCount} textureCount={TextureCount}",
                manifest.RunId, stage.StagedEvent.StagePath,
                stage.StagedEvent.MeshCount, stage.StagedEvent.TextureCount);

            // 4. Phase E + J: template fetch + scaffold + UE editor import.
            //    Pass the staged scene + run stage dir so the Phase J
            //    MvrGdtfDetector can also scan for lighting files.
            var templateTag = TemplateFetcher.DefaultTag;
            ImportResult imported;
            try
            {
                imported = await pipeline
                    .ImportAsync(
                        manifest, install, templateTag, stage.GltfPath, ct,
                        stagedScene: stage.StagedScene,
                        runStageDir: stage.StagePath)
                    .ConfigureAwait(false);
            }
            catch (TemplateNotFoundException ex)
            {
                logger.Error(ex, "template not found tag={Tag}", templateTag);
                EmitFailedEvent(manifest.RunId, FailedEvent.CodeTemplateNotFound, ex.Message);
                return ExitCodes.Failure;
            }
            catch (TemplateFetchException ex)
            {
                logger.Error(ex, "template fetch failed tag={Tag}", templateTag);
                EmitFailedEvent(manifest.RunId, FailedEvent.CodeTemplateFetchFailed, ex.Message);
                return ExitCodes.Failure;
            }
            catch (UnrealLaunchTimeoutException ex)
            {
                logger.Error(ex, "ue import timed out");
                EmitFailedEvent(manifest.RunId, FailedEvent.CodeUeTimeout, ex.Message);
                return ExitCodes.UeTimeout;
            }
            catch (UnrealLaunchException ex)
            {
                logger.Error(ex, "ue import failed");
                EmitFailedEvent(manifest.RunId, FailedEvent.CodeUeImportFailed, ex.Message);
                return ExitCodes.UeImportFailed;
            }
            catch (Exception ex)
            {
                logger.Error(ex, "phase E failed");
                EmitFailedEvent(manifest.RunId, FailedEvent.CodeScaffoldFailed, ex.Message);
                return ExitCodes.Failure;
            }

            Console.Out.Write(imported.ImportedEvent.ToJsonLine());
            Console.Out.Write('\n');
            Console.Out.Flush();
            logger.Information(
                "imported event emitted runId={RunId} project={Project} level={Level} assets={Assets} importMs={ImportMs}",
                manifest.RunId,
                imported.ImportedEvent.ProjectPath,
                imported.ImportedEvent.LevelPath,
                imported.ImportedEvent.AssetCount,
                imported.ImportedEvent.ImportDurationMs);

            scaffold = imported.Scaffold;
        }

        // 5. Phase F: Cirrus + UE bring-up. The session owns
        //    both child processes; on any error here we DO emit a
        //    typed failed/v1 event AND a ready/v1 status=failed line
        //    (the agent reads both, but the ready event is what the
        //    server's WS handler binds against).
        // External Portal connection for the UE plug-ins, forwarded by the
        // agent via PRISM_PORTAL_URL / PRISM_REBUS_API_KEY. Null when neither
        // is set, so the launcher omits both flags. The API key is a SECRET
        // and is never logged (mirrors -OrbitToken=); we log only the URL +
        // a presence flag here so a run's Portal wiring is diagnosable.
        var portal = PortalSettings.FromEnvironment();
        if (portal is not null)
        {
            logger.Information(
                "portal connection forwarded to UE: url={PortalUrl} rebusApiKey={RebusApiKey}",
                portal.HasUrl ? portal.Url : "<unset>",
                portal.HasApiKey ? "set (redacted)" : "<unset>");
        }

        PixelStreamingSession session;
        try
        {
            session = await pipeline
                .StartStreamingAsync(
                    manifest, install, scaffold,
                    fullEditor: fullEditor, orbitImport: orbitImport,
                    portal: portal, ct: ct)
                .ConfigureAwait(false);
        }
        catch (SignallingNotFoundException ex)
        {
            logger.Error(ex, "signalling-server entrypoint missing under UE root");
            EmitFailedEvent(manifest.RunId, FailedEvent.CodeSignallingNotFound, ex.Message);
            EmitFailedReady(manifest, ex.Message);
            return ExitCodes.Failure;
        }
        catch (SignallingBootstrapException ex)
        {
            logger.Error(ex, "auto-bootstrap of PixelStreaming2 signalling stack failed");
            EmitFailedEvent(manifest.RunId, FailedEvent.CodeSignallingBootstrapFailed, ex.Message);
            EmitFailedReady(manifest, ex.Message);
            return ExitCodes.Failure;
        }
        catch (NodeNotFoundException ex)
        {
            logger.Error(ex, "node.exe missing under UE root");
            EmitFailedEvent(manifest.RunId, FailedEvent.CodeNodeNotFound, ex.Message);
            EmitFailedReady(manifest, ex.Message);
            return ExitCodes.Failure;
        }
        catch (SignallingStartTimeoutException ex)
        {
            logger.Error(ex, "cirrus failed to log ready line");
            EmitFailedEvent(manifest.RunId, FailedEvent.CodeSignallingStartTimeout, ex.Message);
            EmitFailedReady(manifest, ex.Message);
            return ExitCodes.SignallingStartTimeout;
        }
        catch (UeGameStartTimeoutException ex)
        {
            logger.Error(ex, "ue -game never registered streamer");
            EmitFailedEvent(manifest.RunId, FailedEvent.CodeUeGameStartTimeout, ex.Message);
            EmitFailedReady(manifest, ex.Message);
            return ExitCodes.UeGameStartFailure;
        }
        catch (UnrealLaunchException ex)
        {
            logger.Error(ex, "ue -game crashed before streamer connected");
            EmitFailedEvent(manifest.RunId, FailedEvent.CodeUeGameCrashed, ex.Message);
            EmitFailedReady(manifest, ex.Message);
            return ExitCodes.UeGameStartFailure;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            logger.Information("phase F cancelled before streamer connected");
            return ExitCodes.Success;
        }
        catch (Exception ex)
        {
            logger.Error(ex, "phase F bring-up failed");
            EmitFailedEvent(manifest.RunId, FailedEvent.CodeUeGameCrashed, ex.Message);
            EmitFailedReady(manifest, ex.Message);
            return ExitCodes.Failure;
        }

        // 6. Emit the FINAL ready event. Once this line is on stdout
        //    the agent considers the run live and starts forwarding
        //    signalling traffic to Cirrus.
        await using (session)
        {
            var ready = session.BuildReadyEvent(
                manifest.RunId,
                manifest.ProjectId,
                manifest.ModelId,
                manifest.VersionId,
                manifest.LogsDirectory);
            ReadyHandshake.Write(ready);
            logger.Information(
                "ready event emitted runId={RunId} playerUrl={PlayerUrl} signallingUrl={SignallingUrl} streamerId={StreamerId} ue={UePid} cirrus={CirrusPid}",
                ready.RunId, ready.PlayerUrl, ready.SignallingUrl, ready.StreamerId,
                ready.UeProcessId, ready.SignallingProcessId);

            // 7. Block until UE exits OR cancellation. On both
            //    paths the session's DisposeAsync handles cleanup:
            //    UE first, then Cirrus, with a 5s grace period.
            var exit = await session.RunUntilExitAsync(ct).ConfigureAwait(false);

            if (ct.IsCancellationRequested)
            {
                // Graceful Ctrl+C / SIGTERM: exit 0.
                logger.Information("phase F: clean shutdown on cancellation");
                return ExitCodes.Success;
            }

            // UE exited on its own. Non-zero codes typically mean a
            // crash; we propagate Success only when UE exited 0
            // (which it does when the level requests EngineQuit
            // via blueprint).
            if (exit == 0)
            {
                logger.Information("phase F: ue exited cleanly");
                return ExitCodes.Success;
            }

            var msg = $"UE -game exited with code {exit} after streamer was connected.";
            logger.Error("phase F: {Message}", msg);
            EmitFailedEvent(manifest.RunId, FailedEvent.CodeUeGameCrashed, msg);
            return ExitCodes.UeGameStartFailure;
        }
    }

    /// <summary>
    /// Decide whether the streaming pass should use the connector-import path
    /// and, if so, prepare the fixed visualiser project locally and return its
    /// scaffold. Returns <c>null</c> to mean "fall through to the legacy
    /// Interchange path" — either because connector-import was forced off, the
    /// fixed project / plug-in isn't present (auto-detect), or preparing the
    /// project failed (resilience: a misconfig must not fully regress the
    /// working visualiser).
    ///
    /// <para>Decision matrix on <paramref name="connectorImport"/>:</para>
    /// <list type="bullet">
    ///   <item><description><c>false</c> — forced Interchange; returns null immediately.</description></item>
    ///   <item><description><c>true</c> — forced connector; uses it as long as the fixed project exists (warns if the plug-in isn't detected).</description></item>
    ///   <item><description><c>null</c> — auto: uses the connector only when the fixed project exists AND ships the connector plug-in + orbit-cli.</description></item>
    /// </list>
    /// </summary>
    private static async Task<ScaffoldResult?> TryPrepareConnectorImportAsync(
        VisualiserPipeline pipeline,
        RunManifest manifest,
        bool? connectorImport,
        Serilog.ILogger logger,
        CancellationToken ct)
    {
        if (connectorImport == false)
        {
            logger.Information(
                "connector-import: disabled ({EnvVar}/--connector-import false) — using the Interchange importer.",
                ConnectorImportEnvVar);
            return null;
        }

        var source = TemplateProjectProvider.ResolveSource();
        var detection = OrbitConnectorLocator.Detect(source);

        if (connectorImport == true)
        {
            // Forced on: require the project to exist (can't stream a missing
            // project), but tolerate a non-detected plug-in with a warning —
            // the operator explicitly asked for the connector path.
            if (!Directory.Exists(source))
            {
                logger.Warning(
                    "connector-import: FORCED ON but the configured fixed project '{Source}' " +
                    "({EnvVar}) does not exist — falling back to the Interchange importer.",
                    source, TemplateProjectProvider.TemplateSourceEnvVar);
                return null;
            }
            if (!detection.IsUsable)
            {
                logger.Warning(
                    "connector-import: FORCED ON; proceeding with fixed project '{Source}' even though " +
                    "the connector plug-in was not fully detected ({Reason}). The import will fail inside " +
                    "UE if the OrbitConnector plug-in + orbit-cli are not actually present.",
                    source, detection.Reason);
            }
        }
        else
        {
            // Auto-detect: only take the connector path when the project ships
            // a usable connector. Otherwise stay on the proven Interchange path.
            if (!detection.IsUsable)
            {
                logger.Information(
                    "connector-import: auto-detect declined for '{Source}' ({Reason}) — using the Interchange importer. " +
                    "Set {EnvVar}=1 to force, or install the OrbitConnector.UE5 plug-in into the project.",
                    source, detection.Reason ?? "not usable", ConnectorImportEnvVar);
                return null;
            }
            logger.Information(
                "connector-import: auto-detected connector plug-in in '{Source}' (uplugin={Uplugin} cli={Cli}).",
                source, detection.UpluginPath, detection.CliPath);
        }

        try
        {
            return await pipeline.PrepareTemplateProjectAsync(manifest, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.Warning(ex,
                "connector-import: failed to prepare fixed project '{Source}' — falling back to the Interchange importer.",
                source);
            return null;
        }
    }

    /// <summary>
    /// Emit an informational <c>prism-visualiser/connector-import/v1</c> stdout
    /// line so the per-run agent log records that the connector path was chosen.
    /// The agent forwards only ready/failed envelopes, so unknown schemas are
    /// merely logged — this stays backward-compatible with older agents.
    /// </summary>
    private static void EmitConnectorImportEvent(RunManifest manifest, string projectRoot)
    {
        try
        {
            var json = System.Text.Json.JsonSerializer.Serialize(new
            {
                schema = "prism-visualiser/connector-import/v1",
                runId = manifest.RunId,
                projectId = manifest.ProjectId,
                modelId = manifest.ModelId,
                versionId = manifest.VersionId,
                server = manifest.Server.Name,
                projectRoot,
            });
            Console.Out.Write(json);
            Console.Out.Write('\n');
            Console.Out.Flush();
        }
        catch
        {
            // stdout closed — the on-disk log already recorded the decision.
        }
    }

    /// <summary>
    /// Build a single-line failure message from
    /// <see cref="UnrealEnvironment.ResolveDetailed"/> diagnostics. The
    /// historical "env var is set but does not point at a valid UE 5.7
    /// install" string told operators nothing — they couldn't tell
    /// whether the directory was wrong, missing, or just lacked the
    /// editor binary. This formatter folds every probe outcome into the
    /// message so the failed/v1 event surfaced to the server (and from
    /// there to the agent log and admin UI) is actionable in one read.
    /// </summary>
    private static string FormatUeRootFailure(UnrealResolution resolution)
    {
        var parts = new List<string>();
        var envVar = UnrealEnvironment.EnvVarSet();
        var summary = envVar
            ? $"{UnrealEnvironment.EnvVarName} is set but does not point at a valid UE 5.7 install."
            : $"UE 5.7 install not found via env var ({UnrealEnvironment.EnvVarName}), default path ({UnrealEnvironment.DefaultInstallRoot}), or registry ({UnrealEnvironment.RegistryKeyPath}).";
        parts.Add(summary);

        foreach (var probe in resolution.Diagnostics)
        {
            if (probe.Install is not null) continue;
            var raw = probe.RawRoot ?? "<unset>";
            var normalized = probe.NormalizedRoot ?? "<unset>";
            var reason = probe.FailureReason ?? "(no reason)";
            // Only include the normalized path when it differs from the
            // raw value (it usually does — Path.GetFullPath strips
            // trailing slashes, fixes mixed separators, BOM strip).
            // Otherwise the message gets cluttered with duplicate paths.
            var pathPart = string.Equals(raw, normalized, StringComparison.Ordinal)
                ? $"path={raw}"
                : $"raw={raw} normalized={normalized}";
            parts.Add($"[{probe.Source}] {pathPart} — {reason}");
        }
        return string.Join(" | ", parts);
    }

    /// <summary>
    /// Best-effort write of a <c>status=failed</c> ready event on
    /// Phase F failures. The agent reads either the failed/v1 event
    /// or this — we emit both so older agents still see a structured
    /// ReadyEvent.
    /// </summary>
    private static void EmitFailedReady(RunManifest manifest, string message)
    {
        try
        {
            ReadyHandshake.Write(ReadyEvent.Failed(
                manifest.RunId, manifest.ProjectId, manifest.ModelId, manifest.VersionId,
                manifest.LogsDirectory, message));
        }
        catch
        {
            // stdout closed — nothing more we can do.
        }
    }

    /// <summary>
    /// Write a <c>prism-visualiser/failed/v1</c> JSON line to stdout.
    /// Best-effort: stdout-redirect failures fall through silently
    /// (the per-run log on disk has the full failure trace).
    /// </summary>
    private static void EmitFailedEvent(string runId, string code, string message)
    {
        try
        {
            var ev = FailedEvent.For(runId, code, message);
            Console.Out.Write(ev.ToJsonLine());
            Console.Out.Write('\n');
            Console.Out.Flush();
        }
        catch
        {
            // stdout closed, redirected to a dead pipe — nothing more
            // we can do. The on-disk log keeps the failure record.
        }
    }

    /// <summary>
    /// Flush + dispose the per-run Serilog logger. <see cref="Serilog.ILogger"/>
    /// itself does not expose <see cref="IDisposable"/>; the concrete
    /// <c>Logger</c> class returned by <see cref="StructuredLog.CreateRunLogger"/>
    /// does. Calling <see cref="IDisposable.Dispose"/> blocks until pending
    /// file writes flush, which is critical when we follow this with
    /// <see cref="Environment.Exit(int)"/>.
    /// </summary>
    private static void FlushLogger(Serilog.ILogger logger)
    {
        if (logger is IDisposable disposable)
        {
            disposable.Dispose();
        }
    }
}
