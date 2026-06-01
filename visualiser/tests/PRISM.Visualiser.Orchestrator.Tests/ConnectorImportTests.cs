using System.Runtime.Versioning;

using PRISM.Visualiser.Orchestrator.Unreal;

using Xunit;

namespace PRISM.Visualiser.Orchestrator.Tests;

/// <summary>
/// Covers the connector-import surface added for the OrbitConnector.UE5
/// streaming path: project plug-in detection and the <c>-Orbit*</c> tokens the
/// <c>-game</c> launch passes to the connector's headless auto-import.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ConnectorImportTests
{
    private static ScaffoldResult MakeScaffold(string root, string levelPath) => new(
        ProjectRoot: root,
        UprojectPath: Path.Combine(root, "REBUS_Visualiser.uproject"),
        DefaultEngineIniPath: Path.Combine(root, "Config", "DefaultEngine.ini"),
        PythonScriptPath: string.Empty,
        LevelPath: levelPath,
        DescriptionRewritten: false);

    private static UnrealInstall MakeInstall() => new(
        Root: @"C:\Program Files\Epic Games\UE_5.7",
        EditorCmdPath: @"C:\Program Files\Epic Games\UE_5.7\Engine\Binaries\Win64\UnrealEditor-Cmd.exe",
        Source: UnrealResolutionSource.EnvironmentVariable);

    [Fact]
    public void Detect_ReturnsUsable_WhenUpluginAndCliPresent()
    {
        var root = Path.Combine(Path.GetTempPath(), "prismvis-detect-" + Guid.NewGuid().ToString("N"));
        var pluginDir = Path.Combine(root, "Plugins", OrbitConnectorLocator.PluginFolderName);
        var cliDir = Path.Combine(pluginDir, "ThirdParty", "Cli", "win-x64");
        Directory.CreateDirectory(cliDir);
        File.WriteAllText(Path.Combine(pluginDir, OrbitConnectorLocator.UpluginFileName), "{}");
        File.WriteAllText(Path.Combine(cliDir, "orbit-cli.exe"), "stub");

        try
        {
            var detection = OrbitConnectorLocator.Detect(root);
            Assert.True(detection.PluginPresent);
            Assert.True(detection.CliPresent);
            Assert.True(detection.IsUsable);
            Assert.Null(detection.Reason);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Detect_NotUsable_WhenCliMissing()
    {
        var root = Path.Combine(Path.GetTempPath(), "prismvis-detect-" + Guid.NewGuid().ToString("N"));
        var pluginDir = Path.Combine(root, "Plugins", OrbitConnectorLocator.PluginFolderName);
        Directory.CreateDirectory(pluginDir);
        File.WriteAllText(Path.Combine(pluginDir, OrbitConnectorLocator.UpluginFileName), "{}");

        try
        {
            var detection = OrbitConnectorLocator.Detect(root);
            Assert.True(detection.PluginPresent);
            Assert.False(detection.CliPresent);
            Assert.False(detection.IsUsable);
            Assert.NotNull(detection.Reason);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Detect_NotUsable_WhenProjectMissing()
    {
        var detection = OrbitConnectorLocator.Detect(@"C:\does\not\exist-" + Guid.NewGuid().ToString("N"));
        Assert.False(detection.IsUsable);
        Assert.NotNull(detection.Reason);
    }

    [Fact]
    public void GameStartInfo_OmitsOrbitTokens_WhenNoImportParams()
    {
        var psi = UnrealLauncher.BuildGameStartInfoForTest(
            MakeInstall(),
            MakeScaffold(@"C:\proj", "/Game/REBUS/Maps/Imported_run.Imported_run"),
            "ws://127.0.0.1:8888", "orbit_run");

        Assert.DoesNotContain(psi.ArgumentList, a => a.StartsWith("-OrbitProject=", StringComparison.Ordinal));
        Assert.DoesNotContain(psi.ArgumentList, a => a.StartsWith("-OrbitServer=", StringComparison.Ordinal));
    }

    [Fact]
    public void GameStartInfo_AddsOrbitTokens_WhenImportParamsSupplied()
    {
        var orbit = new OrbitImportParams(
            Server: "prod", ProjectId: "proj123", ModelId: "model456",
            VersionId: "ver789", Token: "secretpat", Target: "prod");

        var psi = UnrealLauncher.BuildGameStartInfoForTest(
            MakeInstall(),
            MakeScaffold(@"C:\proj", "/Game/REBUS/Maps/Imported_run.Imported_run"),
            "ws://127.0.0.1:8888", "orbit_run",
            orbitImport: orbit);

        Assert.Contains("-OrbitServer=prod", psi.ArgumentList);
        Assert.Contains("-OrbitProject=proj123", psi.ArgumentList);
        Assert.Contains("-OrbitModel=model456", psi.ArgumentList);
        Assert.Contains("-OrbitVersion=ver789", psi.ArgumentList);
        Assert.Contains("-OrbitToken=secretpat", psi.ArgumentList);
        Assert.Contains("-OrbitTarget=prod", psi.ArgumentList);
        // Still a real -game streaming launch.
        Assert.Contains("-game", psi.ArgumentList);
        Assert.Contains("-PixelStreamingURL=ws://127.0.0.1:8888", psi.ArgumentList);
    }

    [Fact]
    public void GameStartInfo_OmitsEmptyLevelArg_ForFixedProjectStartupMap()
    {
        // Fixed project with no recorded EditorStartupMap → no map token, so UE
        // boots the project's own GameDefaultMap (no empty positional arg).
        var psi = UnrealLauncher.BuildGameStartInfoForTest(
            MakeInstall(),
            MakeScaffold(@"C:\proj", levelPath: string.Empty),
            "ws://127.0.0.1:8888", "orbit_run");

        Assert.DoesNotContain(string.Empty, psi.ArgumentList);
        // The uproject is still the first positional arg, immediately followed
        // by -game (no blank level token in between).
        var uprojectIdx = psi.ArgumentList.IndexOf(psi.ArgumentList.First(a => a.EndsWith(".uproject", StringComparison.Ordinal)));
        Assert.Equal("-game", psi.ArgumentList[uprojectIdx + 1]);
    }
}
