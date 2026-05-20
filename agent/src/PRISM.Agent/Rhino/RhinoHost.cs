using Microsoft.Extensions.Logging;

namespace PRISM.Agent.Rhino;

/// <summary>
/// Process-wide Rhino host wrapper.
///
/// Conceptually owns the single in-process Rhino 8 instance the agent
/// drives via Rhino.Inside; per-job worker slots ask the host for a
/// fresh <see cref="global::Rhino.RhinoDoc"/> headless document.
///
/// Phase 3 caveat: this class assumes RhinoCommon is already loaded into
/// the process (either by the Rhino.Inside assembly resolver, or by
/// running the agent .exe from inside the Rhino 8 install directory).
/// The PRISM.Agent installer wires that up at install time; running the
/// .exe outside of a workstation install will throw on first call.
/// </summary>
public sealed class RhinoHost : IDisposable
{
    readonly ILogger<RhinoHost> _log;
    bool _disposed;

    public RhinoHost(ILogger<RhinoHost> log, string? rhinoSystemDir = null)
    {
        _log = log;
        if (!string.IsNullOrEmpty(rhinoSystemDir))
        {
            _log.LogInformation("RhinoHost configured with rhinoSystemDir={Dir}", rhinoSystemDir);
        }
        _log.LogInformation("RhinoHost initialised (Rhino bootstrap deferred to installer / first job)");
    }

    public string RhinoVersion =>
        // RhinoApp throws if Rhino isn't loaded — guard so logging doesn't NPE on dev hosts.
        TryGet(() => global::Rhino.RhinoApp.Version.ToString()) ?? "unknown";

    /// <summary>Create a fresh headless RhinoDoc for a job to populate.</summary>
    public global::Rhino.RhinoDoc CreateDoc() =>
        global::Rhino.RhinoDoc.CreateHeadless(null)
        ?? throw new InvalidOperationException("RhinoDoc.CreateHeadless returned null — is Rhino 8 installed?");

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
    }

    static T? TryGet<T>(Func<T> f) where T : class
    {
        try { return f(); } catch { return null; }
    }
}
