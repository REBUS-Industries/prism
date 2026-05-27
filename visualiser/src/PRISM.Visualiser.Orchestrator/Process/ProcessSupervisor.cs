using System.Diagnostics;
using System.Runtime.Versioning;

using Serilog;

namespace PRISM.Visualiser.Orchestrator.Process;

/// <summary>
/// Skeleton supervisor for the Cirrus + UE child processes Phase E/F
/// will spawn. Today it knows how to capture stdout / stderr from a
/// <see cref="System.Diagnostics.Process"/> and forward each line to
/// Serilog with a fixed channel prefix; the real launch / health
/// checks land in Phase E.
///
/// Kept in Phase B so the directory layout is honest about where these
/// concerns will live, and so the JobObject + supervisor pair compiles
/// as a cohesive unit.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ProcessSupervisor : IDisposable
{
    private readonly ILogger _log;
    private readonly JobObject _job;
    private readonly List<SupervisedProcess> _children = new();
    private bool _disposed;

    public ProcessSupervisor(ILogger log, JobObject job)
    {
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _job = job ?? throw new ArgumentNullException(nameof(job));
    }

    /// <summary>
    /// Attach to an already-started process, route its output through
    /// Serilog under <paramref name="channel"/>, and assign it to the
    /// orchestrator's Job Object so it dies with us.
    /// </summary>
    public void Attach(string channel, System.Diagnostics.Process process)
    {
        ArgumentNullException.ThrowIfNull(channel);
        ArgumentNullException.ThrowIfNull(process);
        ThrowIfDisposed();

        _job.AddProcess(process.Id);

        var ctx = _log.ForContext("channel", channel)
                       .ForContext("pid", process.Id);
        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data is not null) ctx.Information("{Line}", e.Data);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is not null) ctx.Warning("{Line}", e.Data);
        };

        if (process.StartInfo.RedirectStandardOutput)
        {
            process.BeginOutputReadLine();
        }
        if (process.StartInfo.RedirectStandardError)
        {
            process.BeginErrorReadLine();
        }

        _children.Add(new SupervisedProcess(channel, process));
        ctx.Information("Attached supervised process {Channel} pid={Pid}", channel, process.Id);
    }

    /// <summary>
    /// Snapshot of currently-supervised processes. Phase E uses this to
    /// expose <c>ueProcessId</c> + <c>signallingProcessId</c> in the
    /// ready event.
    /// </summary>
    public IReadOnlyList<SupervisedProcess> Children => _children;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        // JobObject ownership is intentionally NOT taken here. The
        // caller owns the JobObject (it is process-wide) so the
        // supervisor can be disposed mid-run without tearing down the
        // job.
        foreach (var child in _children)
        {
            try
            {
                if (!child.Process.HasExited)
                {
                    child.Process.Refresh();
                }
            }
            catch
            {
                // Best-effort: the child may already be dead because
                // KILL_ON_JOB_CLOSE fired during shutdown.
            }
        }
        _children.Clear();
    }

    private void ThrowIfDisposed() =>
        ObjectDisposedException.ThrowIf(_disposed, this);

    public sealed record SupervisedProcess(string Channel, System.Diagnostics.Process Process);
}
