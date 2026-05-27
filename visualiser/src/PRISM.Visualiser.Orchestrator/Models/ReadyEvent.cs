using System.Text.Json.Serialization;

namespace PRISM.Visualiser.Orchestrator.Models;

/// <summary>
/// Shape of the line emitted on stdout once the orchestrator has a
/// Pixel-Streaming endpoint ready for the agent to publish back to the
/// PRISM server. Wire schema: <c>prism-visualiser/ready/v1</c>.
///
/// Mirrors the server -> agent WS contract documented in the plan
/// section "Server -> agent WS" and BUILD.md §10. Property names are
/// camelCase to match the on-wire JSON; <see cref="JsonPropertyName"/>
/// is applied explicitly so the build is independent of any ambient
/// <c>JsonSerializerOptions</c> default.
/// </summary>
public sealed record ReadyEvent(
    [property: JsonPropertyName("schema")] string Schema,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("runId")] string RunId,
    [property: JsonPropertyName("projectId")] string ProjectId,
    [property: JsonPropertyName("modelId")] string ModelId,
    [property: JsonPropertyName("versionId")] string VersionId,
    [property: JsonPropertyName("playerUrl")] string PlayerUrl,
    [property: JsonPropertyName("signallingUrl")] string SignallingUrl,
    [property: JsonPropertyName("streamerId")] string StreamerId,
    [property: JsonPropertyName("ueProcessId")] int UeProcessId,
    [property: JsonPropertyName("signallingProcessId")] int SignallingProcessId,
    [property: JsonPropertyName("logsDir")] string LogsDir,
    [property: JsonPropertyName("error")] string? Error = null)
{
    public const string SchemaName = "prism-visualiser/ready/v1";

    public const string StatusReady = "ready";
    public const string StatusFailed = "failed";

    /// <summary>Build a successful ready event.</summary>
    public static ReadyEvent Ready(
        string runId,
        string projectId,
        string modelId,
        string versionId,
        string playerUrl,
        string signallingUrl,
        string streamerId,
        int ueProcessId,
        int signallingProcessId,
        string logsDir) =>
        new(
            Schema: SchemaName,
            Status: StatusReady,
            RunId: runId,
            ProjectId: projectId,
            ModelId: modelId,
            VersionId: versionId,
            PlayerUrl: playerUrl,
            SignallingUrl: signallingUrl,
            StreamerId: streamerId,
            UeProcessId: ueProcessId,
            SignallingProcessId: signallingProcessId,
            LogsDir: logsDir,
            Error: null);

    /// <summary>Build a failure ready event. Phase E will use this on
    /// any orchestrator-side failure before <see cref="StatusReady"/>
    /// was emitted, so the agent can surface a real error to the user
    /// instead of a CLI exit code.</summary>
    public static ReadyEvent Failed(
        string runId,
        string projectId,
        string modelId,
        string versionId,
        string logsDir,
        string error) =>
        new(
            Schema: SchemaName,
            Status: StatusFailed,
            RunId: runId,
            ProjectId: projectId,
            ModelId: modelId,
            VersionId: versionId,
            PlayerUrl: string.Empty,
            SignallingUrl: string.Empty,
            StreamerId: string.Empty,
            UeProcessId: 0,
            SignallingProcessId: 0,
            LogsDir: logsDir,
            Error: error);
}
