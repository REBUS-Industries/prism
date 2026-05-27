namespace PRISM.Visualiser.Orchestrator.Models;

/// <summary>
/// Immutable state captured at the start of a <c>stream</c> run.
/// Threaded through fetch / stage / launch / supervise stages so each
/// component reads its inputs from a single source rather than from
/// scattered CLI argument bindings.
/// </summary>
public sealed record RunManifest(
    string RunId,
    string ProjectId,
    string ModelId,
    string VersionId,
    ServerConfig Server,
    int SignallingPortHint,
    string LogsDirectory,
    bool DryRun);
