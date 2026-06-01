using System.Diagnostics;
using System.Globalization;
using System.Runtime.Versioning;

using Serilog;

using PRISM.Visualiser.Orchestrator.Unreal;

namespace PRISM.Visualiser.Orchestrator.Pipeline;

/// <summary>
/// Resolves a FIXED template Unreal project (currently the REBUS_TEMPLATE
/// project on the AD file share), copies it to a LOCAL working directory on
/// the workstation, and returns a <see cref="ScaffoldResult"/> pointing at
/// the local copy so the full-editor-streaming path can open it directly.
///
/// <para>
/// This is the "Full Editor baseline" target: the ORBIT receive/stage/import
/// pipeline is intentionally bypassed for this mode. We just open the fixed
/// project's startup map in the full editor and auto-start Pixel Streaming.
/// </para>
///
/// <para>
/// <b>Why copy locally?</b> Opening a <c>.uproject</c> directly off a UNC
/// share is slow and fragile — UE writes Saved/Intermediate/shader-cache and
/// the share may be read-only or contended. We mirror the source tree into
/// <c>%LOCALAPPDATA%\PRISM.Visualiser\templates\&lt;name&gt;</c> (skipping the
/// UE-generated dirs), cache it between runs (only changed source files are
/// re-copied), and launch the editor on the local copy.
/// </para>
///
/// <para>
/// <b>Share access:</b> the source UNC is AD-hosted. The PRISM agent runs as
/// the interactive LocalUser in session 2, which has the share connected, so
/// the orchestrator child inherits that access. If LocalUser logs off (or the
/// share connection drops) the copy will fail with a clear error.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class TemplateProjectProvider
{
    /// <summary>Default template source (overridable via env var / agent config).</summary>
    public const string DefaultTemplateSource =
        @"\\fs.ad.rebus.industries\REBUS_Admin\Software\Unreal\REBUS_TEMPLATE";

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

    /// <summary>Resolve the configured source path (env var wins, else default UNC).</summary>
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
    /// Copy the template source to a local working copy and return a scaffold
    /// pointing at it. Synchronous (robocopy + file IO); the pipeline wraps it
    /// in a worker thread.
    /// </summary>
    public ScaffoldResult Prepare(string? source = null, CancellationToken ct = default)
    {
        source = string.IsNullOrWhiteSpace(source) ? ResolveSource() : source.Trim();
        _log.Information("template project: source={Source}", source);

        if (!Directory.Exists(source))
        {
            throw new TemplateProjectException(
                $"Template project source is not accessible: '{source}'. " +
                "The path is an AD file share; the PRISM agent must run as the interactive " +
                "LocalUser (session 2) with the share connected. Verify the share is reachable " +
                "(e.g. the Z: mapping is connected) or set " +
                $"{TemplateSourceEnvVar} / VisualiserTemplateProjectPath to an accessible path.");
        }

        var name = new DirectoryInfo(source.TrimEnd('\\', '/')).Name;
        if (string.IsNullOrWhiteSpace(name)) name = "Template";
        var dest = Path.Combine(ResolveLocalCacheRoot(), Sanitize(name));
        Directory.CreateDirectory(dest);

        CopyTemplate(source, dest, ct);

        var uproject = Directory
            .EnumerateFiles(dest, "*.uproject", SearchOption.TopDirectoryOnly)
            .FirstOrDefault()
            ?? throw new TemplateProjectException(
                $"No .uproject found in the copied template at '{dest}' (source '{source}').");

        var iniPath = Path.Combine(dest, "Config", "DefaultEngine.ini");
        var levelPath = ReadEditorStartupMap(iniPath);

        _log.Information(
            "template project: ready uproject={Uproject} startupMap={Map}",
            uproject, string.IsNullOrEmpty(levelPath) ? "(project default)" : levelPath);

        return new ScaffoldResult(
            ProjectRoot: dest,
            UprojectPath: uproject,
            DefaultEngineIniPath: iniPath,
            PythonScriptPath: string.Empty,
            LevelPath: levelPath,
            DescriptionRewritten: false);
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
