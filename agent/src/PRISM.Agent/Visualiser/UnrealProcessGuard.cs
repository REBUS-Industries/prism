using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace PRISM.Agent.Visualiser;

/// <summary>
/// Detects and (on explicit operator confirmation) force-closes the Unreal
/// Engine processes that lock the visualiser template folder and block a
/// template pull / compile.
///
/// <para>
/// A running <c>UnrealEditor.exe</c> keeps open handles into the template
/// project tree (<c>Intermediate\</c>, <c>Saved\</c>, the
/// <c>.uproject</c> dir itself), so the stage-and-swap step's
/// <c>Directory.Move</c> of the live project fails with
/// "Access to the path '…' is denied" (the field bug). The pull flow first
/// <see cref="Detect"/>s these processes; the agent web UI surfaces them and,
/// only when the operator confirms, the pull re-invokes with force-close so
/// <see cref="ForceCloseAllAsync"/> kills them and waits for their handles to
/// drop before the swap.
/// </para>
///
/// <para>
/// Only the editor / compile processes are targeted by name
/// (<c>UnrealEditor</c>, <c>UnrealEditor-Cmd</c>, <c>CrashReportClient</c>,
/// <c>UnrealBuildTool</c>) — the PRISM orchestrator (<c>prism-visualiser.exe</c>)
/// is deliberately NOT in the list, so a force-close never reaps the
/// orchestrator itself. A <c>UnrealEditor-Cmd</c> spawned by a live visualiser
/// session WILL be closed (that is the explicit, operator-confirmed intent
/// here — pulling a new template necessarily ends any session using the old
/// one); the confirmation prompt makes that consequence clear.
/// </para>
/// </summary>
public static class UnrealProcessGuard
{
    /// <summary>
    /// Process names (without the <c>.exe</c> suffix
    /// <see cref="Process.GetProcessesByName(string)"/> expects) that lock the
    /// template/compile. Intentionally excludes <c>prism-visualiser</c> (the
    /// orchestrator) and bare <c>dotnet</c> (UBT runs as a <c>dotnet</c> child
    /// but is reaped via the editor's process tree; killing arbitrary
    /// <c>dotnet</c> processes would be unsafe collateral).
    /// </summary>
    static readonly string[] TargetNames =
    {
        "UnrealEditor",
        "UnrealEditor-Cmd",
        "CrashReportClient",
        "UnrealBuildTool",
    };

    /// <summary>One detected Unreal process: its image name and PID.</summary>
    public sealed record UnrealProc(string Name, int Pid);

    /// <summary>
    /// Snapshot the currently-running Unreal editor/compile processes. Never
    /// throws — a probe failure for one name is logged at debug and skipped.
    /// Returned list is empty when nothing is running.
    /// </summary>
    public static IReadOnlyList<UnrealProc> Detect(ILogger? log = null)
    {
        var found = new List<UnrealProc>();
        foreach (var name in TargetNames)
        {
            Process[] procs;
            try { procs = Process.GetProcessesByName(name); }
            catch (Exception ex) { log?.LogDebug(ex, "unreal guard: probe for {Name} failed", name); continue; }

            foreach (var p in procs)
            {
                try { found.Add(new UnrealProc(p.ProcessName, p.Id)); }
                catch { /* process exited between enumerate + read */ }
                finally { p.Dispose(); }
            }
        }
        return found;
    }

    /// <summary>
    /// Human-readable one-line summary of detected processes for log / status
    /// messages, e.g. <c>"UnrealEditor (pid 1234), CrashReportClient (pid 5678)"</c>.
    /// </summary>
    public static string Describe(IReadOnlyList<UnrealProc> procs) =>
        procs.Count == 0
            ? "none"
            : string.Join(", ", procs.Select(p => $"{p.Name} (pid {p.Pid})"));

    /// <summary>
    /// Force-close every currently-running target Unreal process
    /// (re-enumerated here so the kill set is fresh, not the stale snapshot the
    /// UI was shown), killing each process tree, then wait until they have all
    /// exited (and their file handles released) or the timeout elapses.
    /// Returns the number of processes that were signalled to die. Never throws
    /// for an individual kill failure — those are logged and the wait proceeds.
    /// </summary>
    public static async Task<int> ForceCloseAllAsync(
        IProgress<string>? progress, ILogger log, CancellationToken ct)
    {
        var live = new List<Process>();
        foreach (var name in TargetNames)
        {
            try { live.AddRange(Process.GetProcessesByName(name)); }
            catch (Exception ex) { log.LogDebug(ex, "unreal guard: re-probe for {Name} failed", name); }
        }

        if (live.Count == 0) return 0;

        progress?.Report($"closing Unreal ({live.Count} process(es))…");
        var killed = 0;
        foreach (var p in live)
        {
            try
            {
                log.LogWarning("template pull: force-closing {Name} (pid {Pid})", p.ProcessName, p.Id);
                p.Kill(entireProcessTree: true);
                killed++;
            }
            catch (Exception ex)
            {
                // Already exited, access denied (e.g. a process owned by
                // another session), etc. — log and keep going.
                log.LogWarning(ex, "template pull: failed to kill pid {Pid}", SafePid(p));
            }
        }

        // Wait for the signalled processes to actually exit.
        using var waitCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        waitCts.CancelAfter(TimeSpan.FromSeconds(30));
        foreach (var p in live)
        {
            try { await p.WaitForExitAsync(waitCts.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                log.LogWarning("template pull: timed out waiting for pid {Pid} to exit", SafePid(p));
            }
            catch (Exception ex) { log.LogDebug(ex, "template pull: wait-for-exit threw for pid {Pid}", SafePid(p)); }
            finally { p.Dispose(); }
        }

        // Poll until no target process remains (covers respawns like the
        // CrashReportClient that UE can launch on a hard kill), then a short
        // settle delay so the OS finishes releasing the freed file handles
        // before the directory swap runs.
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            var still = Detect(log);
            if (still.Count == 0) break;
            log.LogDebug("template pull: still waiting on {Procs}", Describe(still));
            try { await Task.Delay(500, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }

        try { await Task.Delay(1500, ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { /* nop */ }

        log.LogInformation("template pull: force-closed {Killed} Unreal process(es)", killed);
        return killed;
    }

    static int SafePid(Process p)
    {
        try { return p.Id; } catch { return -1; }
    }
}
