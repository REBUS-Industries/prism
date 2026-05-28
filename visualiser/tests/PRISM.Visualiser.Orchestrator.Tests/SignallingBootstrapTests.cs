using System.Runtime.Versioning;

using Xunit;

using PRISM.Visualiser.Orchestrator.PixelStreaming;

namespace PRISM.Visualiser.Orchestrator.Tests;

/// <summary>
/// Smoke Test 17 — <see cref="SignallingBootstrap"/>'s pure-function
/// surface (path resolution, readiness probe, marker layout, arg
/// tokeniser). The actual process-spawning bootstrap is exercised
/// end-to-end on PC01 — we don't try to fake <c>get_ps_servers.bat</c>
/// or <c>start.bat</c> inside the unit suite.
/// </summary>
[SupportedOSPlatform("windows")]
public class SignallingBootstrapTests
{
    [Fact]
    public void IsReady_ReturnsFalse_WhenWilburEntrypointMissing()
    {
        using var tempDir = new TempDir();
        Assert.False(SignallingBootstrap.IsReady(tempDir.Path));
    }

    [Fact]
    public void IsReady_ReturnsTrue_WhenWilburEntrypointExists()
    {
        using var tempDir = new TempDir();
        var wilburPath = Path.Combine(tempDir.Path, SignallingBootstrap.WilburEntrypointRelative);
        Directory.CreateDirectory(Path.GetDirectoryName(wilburPath)!);
        File.WriteAllText(wilburPath, "// fake compiled wilbur\n");

        Assert.True(SignallingBootstrap.IsReady(tempDir.Path));
    }

    [Fact]
    public void ResolveMarkerPath_IsStable_ForSameEngineRoot()
    {
        // Two probes against the same engine root must produce the
        // same marker filename so re-runs hit the cached marker.
        var a = SignallingBootstrap.ResolveMarkerPath(@"C:\Program Files\Epic Games\UE_5.7");
        var b = SignallingBootstrap.ResolveMarkerPath(@"c:\program files\epic games\ue_5.7");
        Assert.Equal(a, b);
        Assert.EndsWith(".flag", a);
    }

    [Fact]
    public void ResolveMarkerPath_DiffersBetween_DifferentEngineRoots()
    {
        var a = SignallingBootstrap.ResolveMarkerPath(@"C:\Program Files\Epic Games\UE_5.7");
        var b = SignallingBootstrap.ResolveMarkerPath(@"C:\Program Files\Epic Games\UE_5.6");
        Assert.NotEqual(a, b);
    }

    [Theory]
    [InlineData("wilbur v3.0.1 starting", true)]
    [InlineData("Listening on port 65000", true)]
    [InlineData("HTTP webserver listening on port 65000", true)]
    [InlineData("Server started", true)]
    [InlineData("Server listening", true)]
    [InlineData("Cirrus boot: loading config...", false)]
    [InlineData("npm install completed", false)]
    [InlineData("", false)]
    public void WilburReadyPattern_DetectsKnownReadyShapes(string line, bool expected)
    {
        Assert.Equal(expected, SignallingBootstrap.WilburReadyPattern.IsMatch(line));
    }

    [Theory]
    [InlineData("--publicip 127.0.0.1", new[] { "--publicip", "127.0.0.1" })]
    [InlineData("--player_port 65000 --streamer_port 65001",
                new[] { "--player_port", "65000", "--streamer_port", "65001" })]
    [InlineData("--http_root \"C:\\Program Files\\foo\"",
                new[] { "--http_root", @"C:\Program Files\foo" })]
    [InlineData("", new string[0])]
    public void TokenizeArgs_HandlesQuotedAndUnquotedTokens(string input, string[] expected)
    {
        var actual = SignallingBootstrap.TokenizeArgs(input).ToArray();
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void StartupConstantsPoint_AtCanonicalPlugin2Layout()
    {
        // Hard-pinned via const string so a typo doesn't silently
        // ship — the orchestrator can't probe the right files on a
        // real UE install if these paths drift.
        Assert.Equal(
            @"Engine\Plugins\Media\PixelStreaming2\Resources\WebServers\get_ps_servers.bat",
            SignallingBootstrap.GetPsServersRelative);

        Assert.Equal(
            @"Engine\Plugins\Media\PixelStreaming2\Resources\WebServers\SignallingWebServer\dist\index.js",
            SignallingBootstrap.WilburEntrypointRelative);

        Assert.Equal(
            @"Engine\Plugins\Media\PixelStreaming2\Resources\WebServers\SignallingWebServer\platform_scripts\cmd\start.bat",
            SignallingBootstrap.StartBatRelative);
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; }

        public TempDir()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "prism-bootstrap-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); }
            catch { /* best-effort cleanup */ }
        }
    }
}
