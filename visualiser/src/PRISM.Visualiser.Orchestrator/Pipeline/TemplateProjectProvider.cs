using System.Diagnostics;
using System.Globalization;
using System.Runtime.Versioning;

using Serilog;

using PRISM.Visualiser.Orchestrator.Unreal;

namespace PRISM.Visualiser.Orchestrator.Pipeline;

/// <summary>
/// Resolves the FIXED template Unreal project the full-editor and
/// connector-import launch paths open, and returns a <see cref="ScaffoldResult"/>
/// pointing at a usable working copy.
///
/// <para>
/// The project normally comes from the PRISM agent's <b>"pull latest UE
/// template"</b> feature, which downloads + compiles the project locally under
/// <c>VisualiserTemplateRoot</c> (default <c>C:\PRISM\Templates\&lt;ProjectName&gt;</c>)
/// and repoints <c>VisualiserTemplateProjectPath</c> there. The path is
/// forwarded to the orchestrator as
/// <see cref="TemplateSourceEnvVar"/> (<c>PRISM_VISUALISER_TEMPLATE_PROJECT</c>).
/// </para>
///
/// <para>
/// <b>Local source → open IN PLACE (no copy).</b> When the source is already
/// on a local fixed/removable drive (the common case — the agent pulled and
/// built it on this box) we open it directly. The earlier behaviour mirrored
/// it into <c>%LOCALAPPDATA%\PRISM.Visualiser\templates\&lt;name&gt;</c>, which is
/// now a redundant second copy of an already-local, already-compiled project
/// (and would strand the freshly-built <c>Binaries/</c> in two places). UE
/// writes Saved/Intermediate/shader-cache into the project tree, which is fine
/// on a local writable drive and is wiped by the next agent pull's atomic swap.
/// </para>
///
/// <para>
/// <b>Remote/UNC source → copy locally (fallback).</b> If the source is a UNC
/// share (e.g. a legacy <c>\\fs.ad…\REBUS_TEMPLATE</c> pointer) or a mapped
/// network drive, we still mirror it into the local cache first, because
/// opening a <c>.uproject</c> off a share is slow/fragile and the share may be
/// read-only or contended. The mirror skips the regenerable UE dirs, caches
/// between runs (robocopy <c>/E /XO</c>), and the editor launches on the copy.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class TemplateProjectProvider
{
    /// <summary>
    /// Default template source used only when
    /// <see cref="TemplateSourceEnvVar"/> / <c>VisualiserTemplateProjectPath</c>
    /// is unset (i.e. the orchestrator is run standalone without the agent).
    /// Points at the local location the agent's template pull installs into
    /// (<c>VisualiserTemplateRoot\&lt;ProjectName&gt;</c>); <c>REBUSVis</c> is the
    /// <c>orbit-ue-template</c> project's <c>.uproject</c> base name. In normal
    /// operation the agent always forwards the env var, so this default is a
    /// rarely-hit fallback. (Was the now-dead AD UNC share
    /// <c>\\fs.ad.rebus.industries\…\REBUS_TEMPLATE</c>.)
    /// </summary>
    public const string DefaultTemplateSource = @"C:\PRISM\Templates\REBUSVis";

    /// <summary>Env var the agent forwards from <c>VisualiserTemplateProjectPath</c>.</summary>
    public const string TemplateSourceEnvVar = "PRISM_VISUALISER_TEMPLATE_PROJECT";

    // UE-generated / VCS dirs we never need in the working copy. We EXCLUDE
    // only the regenerable/huge dirs (transient shader cache, per-session
    // Saved, build intermediates) and VCS metadata. We MUST keep Binaries/
    // (root module + Plugins/*/Binaries) and Build/ — REBUS_TEMPLATE is a C++
    // project, so the editor needs the prebuilt UnrealEditor-*.dll modules to
    // open. Excluding Binaries makes the editor fail with "Incompatible or
    // missing module" and exit code=1 (it can't compile non-interactively).
    private static readonly string[] ExcludedDirs =
        { "Saved", "Intermediate", "DerivedDataCache", ".vs", ".git" };

    private readonly ILogger _log;

    public TemplateProjectProvider(ILogger log)
        => _log = log ?? throw new ArgumentNullException(nameof(log));

    /// <summary>Resolve the configured source path (env var wins, else the local default).</summary>
    public static string ResolveSource()
    {
        var env = Environment.GetEnvironmentVariable(TemplateSourceEnvVar);
        return string.IsNullOrWhiteSpace(env) ? DefaultTemplateSource : env.Trim();
    }

    /// <summary>Local cache root: <c>%LOCALAPPDATA%\PRISM.Visualiser\templates</c>.</summary>
    public static string ResolveLocalCacheRoot()
    {
        var local = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData,
            Environment.SpecialFolderOption.DoNotVerify);
        return Path.Combine(local, "PRISM.Visualiser", "templates");
    }

    /// <summary>
    /// Resolve the template source to a usable working copy and return a
    /// scaffold pointing at it. A LOCAL source is opened IN PLACE (no copy);
    /// a remote/UNC source is mirrored into the local cache first. Synchronous
    /// (robocopy + file IO); the pipeline wraps it in a worker thread.
    /// </summary>
    public ScaffoldResult Prepare(string? source = null, CancellationToken ct = default)
    {
        source = string.IsNullOrWhiteSpace(source) ? ResolveSource() : source.Trim();
        _log.Information("template project: source={Source}", source);

        if (!Directory.Exists(source))
        {
            throw new TemplateProjectException(
                $"Template project source is not accessible: '{source}' " +
                $"({TemplateSourceEnvVar} / VisualiserTemplateProjectPath). " +
                "Pull the UE template onto this workstation (agent: \"Pull latest UE template\", " +
                "installs into VisualiserTemplateRoot\\<ProjectName>), or point the path at an " +
                "accessible local project. If the path is a UNC share, the PRISM agent must run as " +
                "an interactive user with that share connected so the orchestrator child inherits access.");
        }

        var name = new DirectoryInfo(source.TrimEnd('\\', '/')).Name;
        if (string.IsNullOrWhiteSpace(name)) name = "Template";

        string projectRoot;
        if (IsLocalSource(source))
        {
            // Already on a local fixed/removable drive (the agent pulled +
            // compiled it here). Open IN PLACE — mirroring it into LOCALAPPDATA
            // would just double-copy an already-local, already-built project.
            projectRoot = source.TrimEnd('\\', '/');
            _log.Information(
                "template project: source is local — opening IN PLACE at {Root} (no mirror copy)",
                projectRoot);
        }
        else
        {
            // Remote/UNC/mapped-network source: mirror into the local cache so
            // UE has a fast, writable tree (Saved/Intermediate/shader cache).
            var dest = Path.Combine(ResolveLocalCacheRoot(), Sanitize(name));
            Directory.CreateDirectory(dest);
            _log.Information(
                "template project: source is remote/UNC — mirroring to local cache {Dest}", dest);
            CopyTemplate(source, dest, ct);
            projectRoot = dest;
        }

        var uproject = SelectUproject(projectRoot, name, source);

        var iniPath = Path.Combine(projectRoot, "Config", "DefaultEngine.ini");
        var levelPath = ReadEditorStartupMap(iniPath);

        _log.Information(
            "template project: ready uproject={Uproject} startupMap={Map}",
            uproject, string.IsNullOrEmpty(levelPath) ? "(project default)" : levelPath);

        return new ScaffoldResult(
            ProjectRoot: projectRoot,
            UprojectPath: uproject,
            DefaultEngineIniPath: iniPath,
            PythonScriptPath: string.Empty,
            LevelPath: levelPath,
            DescriptionRewritten: false);
    }

    /// <summary>
    /// True when <paramref name="source"/> is on a local fixed/removable drive
    /// (so it can be opened in place). False for UNC paths
    /// (<c>\\server\share</c>) and mapped <b>network</b> drives — those are
    /// "remote" and get mirrored to the local cache. Anything we can't classify
    /// (relative path, unreadable drive) is treated as remote so the copy
    /// fallback preserves the historical behaviour.
    /// </summary>
    public static bool IsLocalSource(string source)
    {
        if (string.IsNullOrWhiteSpace(source)) return false;
        // UNC (\\server\share, \\?\UNC\…) is always remote.
        if (source.StartsWith(@"\\", StringComparison.Ordinal)) return false;
        if (!Path.IsPathRooted(source)) return false;
        try
        {
            var root = Path.GetPathRoot(source);
            if (string.IsNullOrEmpty(root)) return false;
            var driveType = new DriveInfo(root).DriveType;
            // Fixed/Removable/Ram are local; Network/CDRom/NoRootDirectory/Unknown are not.
            return driveType is DriveType.Fixed or DriveType.Removable or DriveType.Ram;
        }
        catch
        {
            // Unknown/unreadable → be conservative and treat as remote (copy).
            return false;
        }
    }

    /// <summary>
    /// Deterministically choose the project descriptor to launch from the
    /// working copy.
    ///
    /// <para>
    /// The local cache is a persistent robocopy <c>/E /XO</c> mirror with no
    /// <c>/PURGE</c>, so files that once existed in the source but were later
    /// removed/renamed are NOT deleted from the cache. The classic offender is
    /// the engine's default <c>MyProject.uproject</c> left over from when the
    /// template was first scaffolded (UE names new projects "MyProject"): it
    /// lingers next to the real <c>&lt;TemplateName&gt;.uproject</c> forever.
    /// </para>
    ///
    /// <para>
    /// The old code did <c>EnumerateFiles("*.uproject").FirstOrDefault()</c>,
    /// which returns the alphabetically-first descriptor — so a stale
    /// <c>MyProject.uproject</c> shadowed <c>REBUS_Visualiser.uproject</c> and
    /// UE launched a project that did not enable the PixelStreaming2 plugin,
    /// causing the orchestrator to time out waiting for a streamer that the
    /// engine never tried to register. We now prefer the descriptor whose name
    /// matches the template/source directory, fall back to the most recently
    /// modified, and loudly warn about the extras so the cache/source can be
    /// cleaned up.
    /// </para>
    /// </summary>
    private string SelectUproject(string dest, string templateName, string source)
    {
        var candidates = Directory
            .EnumerateFiles(dest, "*.uproject", SearchOption.TopDirectoryOnly)
            .ToList();

        if (candidates.Count == 0)
        {
            throw new TemplateProjectException(
                $"No .uproject found in the copied template at '{dest}' (source '{source}').");
        }

        if (candidates.Count == 1)
            return candidates[0];

        // Multiple descriptors — pick the one matching the template directory
        // name; otherwise the newest. Never silently take the alphabetical first.
        var byName = candidates.FirstOrDefault(p =>
            string.Equals(
                Path.GetFileNameWithoutExtension(p), templateName,
                StringComparison.OrdinalIgnoreCase));

        var chosen = byName ?? candidates
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .First();

        var ignored = string.Join(
            ", ", candidates.Where(p => !string.Equals(p, chosen, StringComparison.OrdinalIgnoreCase))
                            .Select(Path.GetFileName));

        _log.Warning(
            "template project: {Count} .uproject files present in working copy {Dest}; " +
            "selected '{Chosen}' (matched template name: {MatchedByName}). Ignored stale " +
            "descriptor(s): {Ignored}. Remove the stale file(s) from the source/cache so " +
            "the correct project is unambiguous.",
            candidates.Count, dest, Path.GetFileName(chosen), byName is not null, ignored);

        return chosen;
    }

    private void CopyTemplate(string source, string dest, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // robocopy <src> <dst> /E /XO  — copy tree, skip files where the dest
        // copy is the same age or newer (so cached runs only re-pull changed
        // source files). /XD prunes the UE-generated + VCS dirs. robocopy exit
        // codes 0–7 are success (8+ is a real failure).
        var args = new List<string> { source, dest, "/E", "/XO", "/R:2", "/W:2", "/NFL", "/NDL", "/NJH", "/NJS", "/NP" };
        args.Add("/XD");
        foreach (var d in ExcludedDirs) args.Add(Path.Combine(source, d));

        var psi = new ProcessStartInfo
        {
            FileName = "robocopy.exe",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        var sw = Stopwatch.StartNew();
        using var proc = System.Diagnostics.Process.Start(psi)
            ?? throw new TemplateProjectException("Failed to start robocopy for template copy.");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();
        sw.Stop();

        var code = proc.ExitCode;
        if (code >= 8)
        {
            throw new TemplateProjectException(
                $"robocopy failed copying template (exit={code}) from '{source}' to '{dest}'. " +
                $"stderr: {stderr.Trim()} stdout-tail: {Tail(stdout)}");
        }
        _log.Information(
            "template project: copied source -> {Dest} (robocopy exit={Code}, {Ms} ms)",
            dest, code, sw.ElapsedMilliseconds);
    }

    /// <summary>
    /// Parse <c>EditorStartupMap=/Game/...</c> from the project's
    /// DefaultEngine.ini. Returns the object path (or empty when absent — the
    /// launcher then lets UE open the project's own startup map).
    /// </summary>
    private string ReadEditorStartupMap(string iniPath)
    {
        try
        {
            if (!File.Exists(iniPath)) return string.Empty;
            foreach (var raw in File.ReadAllLines(iniPath))
            {
                var line = raw.Trim();
                if (line.StartsWith("EditorStartupMap=", StringComparison.OrdinalIgnoreCase))
                    return line["EditorStartupMap=".Length..].Trim();
            }
            // Fall back to GameDefaultMap if EditorStartupMap is unset.
            foreach (var raw in File.ReadAllLines(iniPath))
            {
                var line = raw.Trim();
                if (line.StartsWith("GameDefaultMap=", StringComparison.OrdinalIgnoreCase))
                    return line["GameDefaultMap=".Length..].Trim();
            }
        }
        catch (Exception ex)
        {
            _log.Warning(ex, "template project: failed to read EditorStartupMap from {Ini}", iniPath);
        }
        return string.Empty;
    }

    private static string Sanitize(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var clean = new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return string.IsNullOrWhiteSpace(clean) ? "Template" : clean;
    }

    private static string Tail(string s, int max = 400)
        => string.IsNullOrEmpty(s) ? string.Empty
            : (s.Length <= max ? s : s[^max..]).Replace("\r", " ").Replace("\n", " ");
}

/// <summary>Template project could not be resolved / copied.</summary>
public sealed class TemplateProjectException : Exception
{
    public TemplateProjectException(string message) : base(message) { }
    public TemplateProjectException(string message, Exception inner) : base(message, inner) { }
}
