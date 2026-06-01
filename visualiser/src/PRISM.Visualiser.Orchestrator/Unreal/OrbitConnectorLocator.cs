using System.Runtime.Versioning;

namespace PRISM.Visualiser.Orchestrator.Unreal;

/// <summary>
/// Probes a UE project tree for an installed, runnable
/// <c>OrbitConnector.UE5</c> plug-in (the connector + its bundled
/// <c>orbit-cli</c>). This is the gate the streaming pipeline uses to decide
/// whether the fixed visualiser project can drive its own ORBIT import via the
/// connector (preferred) or whether it must fall back to the built-in
/// Interchange importer.
///
/// <para>
/// The connector's <c>FOrbitCliRunner::ResolveCliPath</c> looks for the CLI at
/// <c>&lt;Plugin&gt;\ThirdParty\Cli\win-x64\orbit-cli.exe</c>, so a project
/// "has" the connector for our purposes when BOTH the <c>.uplugin</c> and that
/// CLI exe are present under <c>Plugins\OrbitConnector\</c>.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public static class OrbitConnectorLocator
{
    /// <summary>Plug-in folder name the UE5 installer / updater deposits.</summary>
    public const string PluginFolderName = "OrbitConnector";

    /// <summary>Plug-in descriptor filename.</summary>
    public const string UpluginFileName = "OrbitConnector.uplugin";

    /// <summary>
    /// Relative path (under the plug-in folder) of the bundled Windows CLI.
    /// Mirrors <c>FOrbitCliRunner::ResolveCliPath</c> in the connector runtime.
    /// </summary>
    public static readonly string CliRelativePath =
        Path.Combine("ThirdParty", "Cli", "win-x64", "orbit-cli.exe");

    /// <summary>
    /// Inspect <paramref name="projectRoot"/> for the connector plug-in. Returns
    /// a detection result describing exactly what was (and wasn't) found so the
    /// caller can log an actionable reason when falling back.
    /// </summary>
    public static OrbitConnectorDetection Detect(string? projectRoot)
    {
        if (string.IsNullOrWhiteSpace(projectRoot) || !Directory.Exists(projectRoot))
        {
            return new OrbitConnectorDetection(
                ProjectRoot: projectRoot ?? string.Empty,
                PluginPresent: false,
                CliPresent: false,
                UpluginPath: null,
                CliPath: null,
                Reason: $"project root '{projectRoot ?? "<null>"}' does not exist");
        }

        var pluginDir = Path.Combine(projectRoot, "Plugins", PluginFolderName);
        var upluginPath = Path.Combine(pluginDir, UpluginFileName);
        var cliPath = Path.Combine(pluginDir, CliRelativePath);

        var pluginPresent = File.Exists(upluginPath);
        var cliPresent = File.Exists(cliPath);

        string? reason = null;
        if (!pluginPresent && !cliPresent)
        {
            reason = $"no OrbitConnector plug-in under '{pluginDir}' (neither {UpluginFileName} nor orbit-cli.exe found)";
        }
        else if (!pluginPresent)
        {
            reason = $"orbit-cli.exe present but {UpluginFileName} missing under '{pluginDir}'";
        }
        else if (!cliPresent)
        {
            reason = $"{UpluginFileName} present but bundled CLI missing at '{cliPath}'";
        }

        return new OrbitConnectorDetection(
            ProjectRoot: projectRoot,
            PluginPresent: pluginPresent,
            CliPresent: cliPresent,
            UpluginPath: pluginPresent ? upluginPath : null,
            CliPath: cliPresent ? cliPath : null,
            Reason: reason);
    }
}

/// <summary>Outcome of <see cref="OrbitConnectorLocator.Detect"/>.</summary>
/// <param name="ProjectRoot">The project root that was probed.</param>
/// <param name="PluginPresent">True when the <c>.uplugin</c> descriptor exists.</param>
/// <param name="CliPresent">True when the bundled <c>orbit-cli.exe</c> exists.</param>
/// <param name="UpluginPath">Absolute path of the descriptor (when present).</param>
/// <param name="CliPath">Absolute path of the CLI (when present).</param>
/// <param name="Reason">Human-readable reason when the connector is NOT fully usable; null when it is.</param>
public sealed record OrbitConnectorDetection(
    string ProjectRoot,
    bool PluginPresent,
    bool CliPresent,
    string? UpluginPath,
    string? CliPath,
    string? Reason)
{
    /// <summary>
    /// True only when both the descriptor AND the bundled CLI are present, i.e.
    /// the connector can run a headless import in this project.
    /// </summary>
    public bool IsUsable => PluginPresent && CliPresent;
}
