using System.IO;

namespace PRISM.Agent.Rhino;

/// <summary>
/// Thrown when a typed Rhino <c>File*.Read</c> exceeds its watchdog bound
/// and is abandoned on its worker thread.
///
/// <para>
/// Surfaced to the job's <c>Fail</c> path so a wedged importer — classically
/// a <c>.fbx</c> whose interactive import-options dialog cannot be shown
/// under headless Rhino.Inside — fails just that job instead of hanging the
/// agent's WebSocket / heartbeat indefinitely (the field incident that took
/// the agent process down with WS close code 1006). Derives from
/// <see cref="IOException"/> so the existing job error handling treats it as
/// a file-read failure; callers key off the concrete type to mark the
/// failure non-retryable (re-reading the same wedged file would just hang
/// again).
/// </para>
/// </summary>
public sealed class RhinoReadTimeoutException : IOException
{
    public RhinoReadTimeoutException(string message) : base(message) { }
}

/// <summary>
/// Runs a single synchronous Rhino file read on a dedicated background
/// thread with a bounded wait, so a native importer that wedges (RhinoCommon
/// exposes no cancellation surface for <c>File*.Read</c>) can no longer block
/// the calling worker slot — and therefore the whole agent process — forever.
///
/// <para>
/// Deliberately Rhino-free: the caller supplies the read as a plain
/// <see cref="Func{Boolean}"/>, so this helper is fully unit-testable in CI
/// without a Rhino install (which the build machine usually lacks).
/// </para>
///
/// <para>
/// Threading: the read is executed on a freshly-spawned background thread
/// whose COM apartment is set to match the calling thread. The existing
/// agent pipeline already invokes RhinoCommon from arbitrary
/// <see cref="System.Threading.ThreadPool"/> worker-slot threads (it does NOT
/// pin Rhino to a single main/UI thread), and access stays strictly
/// sequential — the slot thread blocks in <see cref="Run"/> until the read
/// thread finishes — so moving the read onto one dedicated thread does not
/// introduce a new apartment requirement or any concurrent Rhino access.
/// </para>
/// </summary>
public static class RhinoReadWatchdog
{
    /// <summary>
    /// Default bound applied when a caller passes a non-positive timeout.
    /// 150s sits mid-range of the agreed 120–180s window: long enough for a
    /// legitimately large STEP / FBX assembly to parse, short enough that a
    /// wedged importer fails the job in a couple of minutes rather than
    /// hanging the slot forever.
    /// </summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(150);

    /// <summary>
    /// Invoke <paramref name="reader"/> on a dedicated background thread and
    /// wait at most <paramref name="timeout"/> for it.
    /// <list type="bullet">
    /// <item><description>reader returned within the bound → that value is
    /// returned (preserving the caller's <c>true</c>/<c>false</c>
    /// semantics).</description></item>
    /// <item><description>reader threw within the bound → returns
    /// <c>false</c>, preserving the pre-existing "the typed read threw ⇒
    /// treat as a hard read failure (do not fall back to RunScript)" contract
    /// in <see cref="RhinoFileOpener"/>.</description></item>
    /// <item><description>the bound elapsed → throws
    /// <see cref="RhinoReadTimeoutException"/> and abandons the worker thread.
    /// A managed thread blocked in a native call cannot be safely aborted on
    /// .NET 8, so the thread is left to leak; it is a background thread and so
    /// never keeps the process alive at shutdown. The agent process, its
    /// WebSocket, and its heartbeat all stay alive — only this one job
    /// fails.</description></item>
    /// </list>
    /// </summary>
    /// <param name="api">Human-readable label for the read being invoked
    /// (used only in <paramref name="diag"/> lines).</param>
    /// <param name="reader">The synchronous Rhino read. Returns the importer's
    /// success flag.</param>
    /// <param name="timeout">Upper bound on the read. Non-positive values fall
    /// back to <see cref="DefaultTimeout"/>.</param>
    /// <param name="diag">Optional diagnostic sink (forwarded to the agent log
    /// + the WS job-log channel by the caller).</param>
    public static bool Run(string api, Func<bool> reader, TimeSpan timeout, Action<string>? diag = null)
    {
        ArgumentNullException.ThrowIfNull(reader);
        if (timeout <= TimeSpan.Zero) timeout = DefaultTimeout;

        diag?.Invoke($"[OBJ-IMPORT] invoking {api} (BatchMode=True, ImportMode=True, watchdog={timeout.TotalSeconds:0}s)");

        bool result = false;
        Exception? readerError = null;

        var worker = new Thread(() =>
        {
            try { result = reader(); }
            catch (Exception err) { readerError = err; }
        })
        {
            IsBackground = true,
            Name = "rhino-file-read",
        };

        // Match the caller's COM apartment so RhinoCommon sees the same
        // apartment it would on the direct (non-watchdog) call path. On the
        // slot-pool threads this is MTA (the default for a new thread anyway);
        // setting it explicitly keeps the watchdog correct if a caller ever
        // runs the read from an STA thread.
        try { worker.SetApartmentState(Thread.CurrentThread.GetApartmentState()); }
        catch { /* invalid transition on some hosts; the default apartment matches the pool threads */ }

        worker.Start();

        // Thread.Join(timeout) needs no disposable sync primitive and gives a
        // happens-before edge on the worker's writes to result/readerError
        // when it returns true (the thread has terminated).
        if (worker.Join(timeout))
        {
            if (readerError is not null)
            {
                diag?.Invoke($"[OBJ-IMPORT] {api} threw {readerError.GetType().Name}: {readerError.Message}");
                return false;
            }

            diag?.Invoke($"[OBJ-IMPORT] {api} returned {result}");
            return result;
        }

        var msg =
            $"{api} exceeded the {timeout.TotalSeconds:0}s headless read watchdog and was abandoned — the " +
            "importer is wedged (most often an interactive import-options dialog that cannot be shown under " +
            "headless Rhino.Inside, or a malformed/oversized file). Failing this job to keep the PRISM Agent " +
            "responsive; the workstation may need an agent restart before the next import of this type.";
        diag?.Invoke($"[OBJ-IMPORT] {msg}");
        throw new RhinoReadTimeoutException(msg);
    }
}
