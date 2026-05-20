using Microsoft.Extensions.Logging;
using RhinoInside;

namespace PRISM.Agent.Rhino;

/// <summary>
/// Reads <c>RhinoVersion</c> from <see cref="Config.AgentConfig"/> and configures
/// the Rhino.Inside assembly resolver to load Rhino from the matching installation.
///
/// Must be called from <c>Program.Main</c> before any <c>Rhino.*</c> types are accessed.
/// The Rhino.Inside resolver hooks <see cref="AppDomain.CurrentDomain.AssemblyResolve"/>
/// so subsequent loads of RhinoCommon.dll and related assemblies come from the
/// selected Rhino install directory rather than the process directory.
///
/// Supported <c>RhinoVersion</c> values:
///   "auto" (default) — uses <see cref="RhinoFinder.FindRhinoSystemDirectory"/> to
///                      select the highest installed Rhino version found on the machine.
///   "8", "9", etc.   — requires that specific major version; throws if not installed.
///   anything else    — logs a warning and falls back to auto.
/// </summary>
public sealed class RhinoVersionSelector
{
    readonly ILogger<RhinoVersionSelector> _log;

    /// <summary>Path to the selected Rhino System directory, e.g. C:\Program Files\Rhino 8\System</summary>
    public string? SelectedSystemDir { get; private set; }

    /// <summary>True after <see cref="Initialize"/> has successfully called <see cref="Resolver.Initialize"/>.</summary>
    public bool IsInitialized { get; private set; }

    public RhinoVersionSelector(ILogger<RhinoVersionSelector> log) => _log = log;

    /// <summary>
    /// Probe for the requested Rhino version, select the system directory, and call
    /// <see cref="Resolver.Initialize(string)"/> to set up the assembly resolver.
    /// </summary>
    /// <param name="rhinoVersionConfig">
    /// Value of <c>AgentConfig.RhinoVersion</c>. "auto", a major version integer string
    /// (e.g. "8"), or empty/null to fall back to auto.
    /// </param>
    /// <exception cref="InvalidOperationException">
    /// Thrown when a specific major version was requested but is not installed.
    /// The agent exits rather than running without a usable Rhino.
    /// </exception>
    public void Initialize(string? rhinoVersionConfig)
    {
        var version = (rhinoVersionConfig ?? "auto").Trim().ToLowerInvariant();

        string? systemDir;

        if (version is "" or "auto")
        {
            systemDir = RhinoFinder.FindRhinoSystemDirectory(useLatest: true);
            if (string.IsNullOrEmpty(systemDir))
            {
                _log.LogWarning(
                    "RhinoVersionSelector: no Rhino installation found on this machine. " +
                    "The agent will start but cannot process jobs until Rhino is installed.");
                return;
            }
        }
        else if (int.TryParse(version, out int major))
        {
            if (!RhinoFinder.TryFindRhino_Windows(major, useLatest: false, out var found)
                || string.IsNullOrEmpty(found))
            {
                _log.LogError(
                    "RhinoVersionSelector: Rhino {Major} not found at any standard install path. " +
                    "Install Rhino {Major} or set \"rhinoVersion\": \"auto\" in agent-config.json.",
                    major, major);
                throw new InvalidOperationException(
                    $"Rhino {major} is not installed. " +
                    $"Install Rhino {major} or change rhinoVersion to \"auto\" in agent-config.json.");
            }
            systemDir = found;
        }
        else
        {
            _log.LogWarning(
                "RhinoVersionSelector: unrecognised rhinoVersion value \"{Value}\". " +
                "Use \"auto\", \"8\", or \"9\". Falling back to auto.",
                rhinoVersionConfig);
            systemDir = RhinoFinder.FindRhinoSystemDirectory(useLatest: true);
            if (string.IsNullOrEmpty(systemDir))
            {
                _log.LogWarning(
                    "RhinoVersionSelector: no Rhino installation found — agent will start without Rhino");
                return;
            }
        }

        _log.LogInformation("Rhino version selected: {SystemDir}", systemDir);
        SelectedSystemDir = systemDir;
        Resolver.Initialize(systemDir);
        IsInitialized = true;
    }
}
