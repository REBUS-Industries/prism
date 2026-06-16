using System.Diagnostics;
using PRISM.Agent.Rhino;
using Xunit;

namespace PRISM.Agent.Tests;

/// <summary>
/// Unit coverage for <see cref="RhinoReadWatchdog"/> — the bounded-wait
/// wrapper that stops a wedged Rhino importer (the field FBX hang) from
/// taking the whole agent down. The watchdog is deliberately Rhino-free, so
/// these tests run on any CI box without a Rhino install: the "read" is a
/// plain delegate.
/// </summary>
public sealed class RhinoReadWatchdogTests
{
    [Fact]
    public void Run_ReturnsReaderResult_WhenReaderCompletesInTime()
    {
        Assert.True(RhinoReadWatchdog.Run("fast-true", () => true, TimeSpan.FromSeconds(5)));
        Assert.False(RhinoReadWatchdog.Run("fast-false", () => false, TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public void Run_ReturnsFalse_WhenReaderThrows()
    {
        // Preserves the pre-existing "typed read threw ⇒ treat as a hard read
        // failure (return false)" contract in RhinoFileOpener — a throwing
        // reader must NOT surface as a watchdog timeout.
        var result = RhinoReadWatchdog.Run(
            "throwing",
            () => throw new InvalidOperationException("boom"),
            TimeSpan.FromSeconds(5));
        Assert.False(result);
    }

    [Fact]
    public void Run_ThrowsTimeout_WhenReaderExceedsBound()
    {
        var sw = Stopwatch.StartNew();
        // Simulate a wedged native read. The watchdog must abandon it and
        // throw rather than block until the (long) sleep returns; the
        // abandoned reader runs on a background thread, so it cannot keep the
        // test process alive once the run finishes.
        Assert.Throws<RhinoReadTimeoutException>(() =>
            RhinoReadWatchdog.Run(
                "wedged",
                () => { Thread.Sleep(TimeSpan.FromSeconds(30)); return true; },
                TimeSpan.FromMilliseconds(200)));
        sw.Stop();

        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5),
            $"watchdog should release near the 200ms bound, took {sw.ElapsedMilliseconds}ms");
    }

    [Fact]
    public void Run_FallsBackToDefaultTimeout_WhenGivenNonPositive()
    {
        // Non-positive timeout must not mean "wait zero / forever" — it falls
        // back to the default, and a fast reader still returns immediately.
        Assert.True(RhinoReadWatchdog.Run("zero-timeout", () => true, TimeSpan.Zero));
    }

    [Fact]
    public void Run_Throws_OnNullReader()
    {
        Assert.Throws<ArgumentNullException>(() =>
            RhinoReadWatchdog.Run("null-reader", null!, TimeSpan.FromSeconds(1)));
    }
}
