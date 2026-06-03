// SPDX-FileCopyrightText: REBUS-ORBIT
// Hand-maintained C# mirror of shared/contracts/agent-protocol.json + .ts.
// Edit all three in the same commit and let CI's `npm run validate:contracts`
// catch any drift in the MessageType union.

using System.Runtime.Serialization;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;
using Newtonsoft.Json.Serialization;

namespace PRISM.Contracts;

public static class Protocol
{
    public const int Version = 1;
}

[JsonConverter(typeof(StringEnumConverter), typeof(CamelCaseNamingStrategy))]
public enum MessageType
{
    Hello,
    Welcome,
    [EnumMember(Value = "server_ping")]
    ServerPing,
    Heartbeat,
    Assign,
    Ack,
    Progress,
    Log,
    Complete,
    Fail,
    Cancel,
    PollLayers,
    Layers,
    Restart,
    Update,
    PullTemplate,
    // Visualiser (Phase A scaffold — handlers stub-ack `accepted: false`).
    // Phase G adds VisualisationEnded + SignallingFrame for the WS proxy.
    StartVisualisation,
    CancelVisualisation,
    VisualisationReady,
    VisualisationFailed,
    VisualisationEnded,
    SignallingFrame,
    SignallingViewerClose,
    SetViewerControl,
}

[JsonConverter(typeof(StringEnumConverter), typeof(CamelCaseNamingStrategy))]
public enum AgentRole
{
    Conversion,
    Layering,
    Receive,
    Visualiser,
}

[JsonConverter(typeof(StringEnumConverter), typeof(CamelCaseNamingStrategy))]
public enum LogLevel
{
    Debug,
    Info,
    Warn,
    Error,
}

public sealed class Envelope<TData>
{
    [JsonProperty("v")]    public int Version { get; set; } = Protocol.Version;
    [JsonProperty("type")] public MessageType Type { get; set; }
    [JsonProperty("id", NullValueHandling = NullValueHandling.Ignore)]
    public string? Id { get; set; }
    [JsonProperty("ts", NullValueHandling = NullValueHandling.Ignore)]
    public string? Timestamp { get; set; }
    [JsonProperty("data")] public TData Data { get; set; } = default!;

    public static Envelope<TData> New(MessageType type, TData data, string? id = null) => new()
    {
        Version = Protocol.Version,
        Type = type,
        Id = id,
        Timestamp = DateTime.UtcNow.ToString("o"),
        Data = data,
    };
}

/* -------------------------------------------------------------------------- */
/* Agent -> server                                                            */
/* -------------------------------------------------------------------------- */

public sealed class HelloData
{
    [JsonProperty("machineId")]    public string MachineId    { get; set; } = "";
    [JsonProperty("nodeName")]     public string NodeName     { get; set; } = "";
    [JsonProperty("slots")]        public int    Slots        { get; set; }
    [JsonProperty("formats")]      public string[] Formats    { get; set; } = Array.Empty<string>();
    [JsonProperty("roles")]        public AgentRole[] Roles   { get; set; } = Array.Empty<AgentRole>();
    [JsonProperty("agentVersion")] public string AgentVersion { get; set; } = "";
    [JsonProperty("rhinoVersion", NullValueHandling = NullValueHandling.Ignore)]
    public string? RhinoVersion { get; set; }
    /// <summary>Release tag of the orbit-ue-template build currently installed at
    /// VisualiserTemplateProjectPath (read from the .prism-template.json marker,
    /// config fallback). Null/omitted when no template is installed.</summary>
    [JsonProperty("installedTemplateTag", NullValueHandling = NullValueHandling.Ignore)]
    public string? InstalledTemplateTag { get; set; }
    /// <summary>Release tag of the OrbitConnector.UE5 plug-in merged into the
    /// installed template project (companion to installedTemplateTag).</summary>
    [JsonProperty("installedConnectorTag", NullValueHandling = NullValueHandling.Ignore)]
    public string? InstalledConnectorTag { get; set; }
}

public sealed class HeartbeatData
{
    [JsonProperty("slotsBusy")] public int  SlotsBusy { get; set; }
    [JsonProperty("cpuPct",    NullValueHandling = NullValueHandling.Ignore)] public double? CpuPct    { get; set; }
    [JsonProperty("memUsedMb", NullValueHandling = NullValueHandling.Ignore)] public double? MemUsedMb { get; set; }
}

public sealed class AckData
{
    [JsonProperty("jobId")]    public string JobId    { get; set; } = "";
    [JsonProperty("accepted")] public bool   Accepted { get; set; }
    [JsonProperty("reason", NullValueHandling = NullValueHandling.Ignore)]
    public string? Reason { get; set; }
}

public sealed class ProgressData
{
    [JsonProperty("jobId")]   public string  JobId   { get; set; } = "";
    [JsonProperty("stage")]   public string  Stage   { get; set; } = "";
    [JsonProperty("percent", NullValueHandling = NullValueHandling.Ignore)] public double? Percent { get; set; }
    [JsonProperty("message", NullValueHandling = NullValueHandling.Ignore)] public string? Message { get; set; }
}

public sealed class LogData
{
    [JsonProperty("jobId")]   public string   JobId   { get; set; } = "";
    [JsonProperty("level")]   public LogLevel Level   { get; set; }
    [JsonProperty("message")] public string   Message { get; set; } = "";
}

public sealed class CompleteData
{
    [JsonProperty("jobId")]      public string JobId      { get; set; } = "";
    [JsonProperty("versionUrl",   NullValueHandling = NullValueHandling.Ignore)] public string? VersionUrl   { get; set; }
    [JsonProperty("rootObjectId", NullValueHandling = NullValueHandling.Ignore)] public string? RootObjectId { get; set; }
    [JsonProperty("versionId",    NullValueHandling = NullValueHandling.Ignore)] public string? VersionId    { get; set; }
    [JsonProperty("outputs",      NullValueHandling = NullValueHandling.Ignore)] public Dictionary<string, string>? Outputs { get; set; }
    [JsonProperty("stats",        NullValueHandling = NullValueHandling.Ignore)] public CompleteStats? Stats { get; set; }
}

public sealed class CompleteStats
{
    [JsonProperty("objects",     NullValueHandling = NullValueHandling.Ignore)] public int?  Objects     { get; set; }
    [JsonProperty("blobs",       NullValueHandling = NullValueHandling.Ignore)] public int?  Blobs       { get; set; }
    [JsonProperty("uploadBytes", NullValueHandling = NullValueHandling.Ignore)] public long? UploadBytes { get; set; }
    [JsonProperty("elapsedMs",   NullValueHandling = NullValueHandling.Ignore)] public long? ElapsedMs   { get; set; }
}

public sealed class FailData
{
    [JsonProperty("jobId")] public string JobId { get; set; } = "";
    [JsonProperty("error")] public string Error { get; set; } = "";
    [JsonProperty("stack",     NullValueHandling = NullValueHandling.Ignore)] public string? Stack     { get; set; }
    [JsonProperty("retryable", NullValueHandling = NullValueHandling.Ignore)] public bool?   Retryable { get; set; }
}

public sealed class LayerNode
{
    [JsonProperty("name")] public string Name { get; set; } = "";
    [JsonProperty("fullPath", NullValueHandling = NullValueHandling.Ignore)] public string?     FullPath { get; set; }
    [JsonProperty("color",    NullValueHandling = NullValueHandling.Ignore)] public string?     Color    { get; set; }
    [JsonProperty("visible",  NullValueHandling = NullValueHandling.Ignore)] public bool?       Visible  { get; set; }
    [JsonProperty("children", NullValueHandling = NullValueHandling.Ignore)] public LayerNode[]? Children { get; set; }
}

public sealed class LayersData
{
    [JsonProperty("jobId")]  public string      JobId  { get; set; } = "";
    [JsonProperty("layers")] public LayerNode[] Layers { get; set; } = Array.Empty<LayerNode>();
}

/* -------------------------------------------------------------------------- */
/* Server -> agent                                                            */
/* -------------------------------------------------------------------------- */

public sealed class WelcomeData
{
    [JsonProperty("sessionId")]  public string SessionId  { get; set; } = "";
    [JsonProperty("serverTime")] public string ServerTime { get; set; } = "";
    [JsonProperty("heartbeatSeconds", NullValueHandling = NullValueHandling.Ignore)]
    public int? HeartbeatSeconds { get; set; }
}

public sealed class AssignOptions
{
    [JsonProperty("swapYZ",                  NullValueHandling = NullValueHandling.Ignore)] public bool?     SwapYZ                  { get; set; }
    [JsonProperty("quality",                 NullValueHandling = NullValueHandling.Ignore)] public string?   Quality                 { get; set; }
    [JsonProperty("includedLayers",          NullValueHandling = NullValueHandling.Ignore)] public string[]? IncludedLayers          { get; set; }
    [JsonProperty("includeLayerDescendants", NullValueHandling = NullValueHandling.Ignore)] public bool?     IncludeLayerDescendants { get; set; }
}

public sealed class AssignData
{
    [JsonProperty("jobId")]          public string JobId          { get; set; } = "";
    [JsonProperty("jobType", NullValueHandling = NullValueHandling.Ignore)] public string? JobType { get; set; }
    [JsonProperty("slot")]           public int    Slot           { get; set; }
    [JsonProperty("format")]         public string Format         { get; set; } = "";
    [JsonProperty("fileUrl",  NullValueHandling = NullValueHandling.Ignore)] public string? FileUrl  { get; set; }
    [JsonProperty("fileName", NullValueHandling = NullValueHandling.Ignore)] public string? FileName { get; set; }
    [JsonProperty("orbitServerUrl")] public string OrbitServerUrl { get; set; } = "";
    [JsonProperty("orbitToken")]     public string OrbitToken     { get; set; } = "";
    [JsonProperty("projectId")]      public string ProjectId      { get; set; } = "";
    [JsonProperty("modelId")]        public string ModelId        { get; set; } = "";
    [JsonProperty("modelName",         NullValueHandling = NullValueHandling.Ignore)] public string?   ModelName        { get; set; }
    [JsonProperty("receiveVersionId",  NullValueHandling = NullValueHandling.Ignore)] public string?   ReceiveVersionId { get; set; }
    [JsonProperty("outputFormats",     NullValueHandling = NullValueHandling.Ignore)] public string[]? OutputFormats    { get; set; }
    [JsonProperty("outputUploadUrl",   NullValueHandling = NullValueHandling.Ignore)] public string?   OutputUploadUrl  { get; set; }
    [JsonProperty("options",           NullValueHandling = NullValueHandling.Ignore)] public AssignOptions? Options     { get; set; }
}

public sealed class CancelData
{
    [JsonProperty("jobId")] public string JobId { get; set; } = "";
    [JsonProperty("reason", NullValueHandling = NullValueHandling.Ignore)]
    public string? Reason { get; set; }
}

public sealed class PollLayersData
{
    [JsonProperty("jobId")]   public string JobId   { get; set; } = "";
    [JsonProperty("fileUrl")] public string FileUrl { get; set; } = "";
    [JsonProperty("format")]  public string Format  { get; set; } = "";
}

/// <summary>
/// Server -> agent: cleanly exit the agent process. The Windows
/// Scheduled Task respawns it within ~1 min, and the agent also
/// schedules a small helper script that relaunches the EXE after
/// the process exits.
/// </summary>
public sealed class RestartData
{
    [JsonProperty("reason", NullValueHandling = NullValueHandling.Ignore)]
    public string? Reason { get; set; }
}

/// <summary>
/// Server -> agent: check GitHub Releases for a new agent build and
/// apply it if one is available. Reuses Updater.CheckForUpdateAsync +
/// DownloadAndInstallAsync (the same code path as the tray menu's
/// "Check for updates"). <see cref="Tag"/> optionally pins a specific
/// release tag; when null/empty the agent picks the latest.
/// </summary>
public sealed class UpdateData
{
    [JsonProperty("tag", NullValueHandling = NullValueHandling.Ignore)]
    public string? Tag { get; set; }
}

/// <summary>
/// Server -> agent: download the latest (or pinned) <c>orbit-ue-template</c>
/// GitHub release and install it into the workstation's visualiser template
/// root (default <c>C:\PRISM\Templates</c>), then point
/// <c>VisualiserTemplateProjectPath</c> at the pulled project. Fire-and-forget
/// like <see cref="UpdateData"/> — the agent runs the pull in the background
/// and reports progress in its logs. <see cref="Tag"/> optionally pins a
/// specific template release tag; when null/empty the agent uses its
/// configured <c>UnrealTemplateTag</c>, or the repo's latest release if that
/// is empty too.
/// </summary>
public sealed class PullTemplateData
{
    [JsonProperty("tag", NullValueHandling = NullValueHandling.Ignore)]
    public string? Tag { get; set; }

    /// <summary>
    /// When true the agent force-closes any running Unreal Engine instance
    /// (<c>UnrealEditor</c> / <c>UnrealEditor-Cmd</c> / <c>CrashReportClient</c>)
    /// that locks the template folder before pulling — ending any visualiser
    /// session using the current template. When false/omitted and Unreal is
    /// running, the agent web UI refuses and prompts the operator to confirm;
    /// the admin Workstations path passes <c>true</c> (the admin clicked
    /// through its own confirmation dialog).
    /// </summary>
    [JsonProperty("force", NullValueHandling = NullValueHandling.Ignore)]
    public bool? Force { get; set; }
}

/* -------------------------------------------------------------------------- */
/* Visualiser (Phase A scaffold)                                              */
/*                                                                            */
/* These envelopes describe the future signalling between PRISM server and    */
/* a Visualiser agent that hosts the Unreal Engine + Pixel Streaming          */
/* orchestrator. In Phase A the agent acks with `accepted: false` until the   */
/* orchestrator binary lands in Phase F/G.                                    */
/* -------------------------------------------------------------------------- */

/// <summary>
/// Phase J — pointer to a portal-uploaded project attachment (MVR / GDTF /
/// generic blob). The orchestrator downloads each ref into
/// <c>stage/{runId}/attachments/</c> before launching Unreal so the
/// MvrGdtfDetector can pick them up alongside any Speckle-embedded
/// lighting objects.
/// </summary>
public sealed class ProjectAttachmentRef
{
    [JsonProperty("id")]          public string Id          { get; set; } = "";
    [JsonProperty("filename")]    public string Filename    { get; set; } = "";
    [JsonProperty("contentType", NullValueHandling = NullValueHandling.Ignore)] public string? ContentType { get; set; }
    [JsonProperty("sizeBytes")]   public long   SizeBytes   { get; set; }
    [JsonProperty("downloadUrl")] public string DownloadUrl { get; set; } = "";
}

/// <summary>
/// Server -> agent: spin up a Pixel Streaming session for an ORBIT version.
/// The agent imports the model into an Unreal template build, starts the
/// stream, and replies (asynchronously) with <see cref="VisualisationReadyData"/>
/// when the signalling URL is reachable.
/// </summary>
public sealed class StartVisualisationData
{
    [JsonProperty("runId")]          public string RunId          { get; set; } = "";
    [JsonProperty("slot")]           public int    Slot           { get; set; }
    [JsonProperty("orbitServerUrl")] public string OrbitServerUrl { get; set; } = "";
    [JsonProperty("orbitToken")]     public string OrbitToken     { get; set; } = "";
    [JsonProperty("projectId")]      public string ProjectId      { get; set; } = "";
    [JsonProperty("modelId")]        public string ModelId        { get; set; } = "";
    [JsonProperty("versionId",       NullValueHandling = NullValueHandling.Ignore)] public string? VersionId      { get; set; }
    [JsonProperty("templateTag",     NullValueHandling = NullValueHandling.Ignore)] public string? TemplateTag    { get; set; }
    [JsonProperty("signallingUrl",   NullValueHandling = NullValueHandling.Ignore)] public string? SignallingUrl  { get; set; }
    [JsonProperty("ttlSeconds",      NullValueHandling = NullValueHandling.Ignore)] public int?    TtlSeconds     { get; set; }
    /// <summary>
    /// Phase J — project-level lighting design attachments (MVR / GDTF) the
    /// orchestrator downloads alongside the ORBIT glTF before launching UE.
    /// Null/omitted when there are no attachments so older orchestrators that
    /// don't know about the field keep working.
    /// </summary>
    [JsonProperty("attachments", NullValueHandling = NullValueHandling.Ignore)] public ProjectAttachmentRef[]? Attachments { get; set; }
}

/// <summary>
/// Server -> agent: tear down a previously-started visualisation run.
/// </summary>
public sealed class CancelVisualisationData
{
    [JsonProperty("runId")] public string RunId { get; set; } = "";
    [JsonProperty("reason", NullValueHandling = NullValueHandling.Ignore)]
    public string? Reason { get; set; }
}

/// <summary>
/// Agent -> server: the orchestrator has imported the model, started UE,
/// and the signalling endpoint is live. Carries the URL the client SPA
/// should connect its WebRTC negotiation to.
/// </summary>
public sealed class VisualisationReadyData
{
    [JsonProperty("runId")]         public string RunId         { get; set; } = "";
    [JsonProperty("signallingUrl")] public string SignallingUrl { get; set; } = "";
    [JsonProperty("streamerId", NullValueHandling = NullValueHandling.Ignore)] public string? StreamerId { get; set; }
    [JsonProperty("expiresAt",  NullValueHandling = NullValueHandling.Ignore)] public string? ExpiresAt  { get; set; }
}

/// <summary>
/// Agent -> server: the orchestrator could not start (import failed,
/// no GPU, UE crashed, etc.). Terminal state for the run.
/// </summary>
public sealed class VisualisationFailedData
{
    [JsonProperty("runId")] public string RunId { get; set; } = "";
    [JsonProperty("error")] public string Error { get; set; } = "";
    [JsonProperty("stack", NullValueHandling = NullValueHandling.Ignore)] public string? Stack { get; set; }
}

/// <summary>
/// Agent -> server: a previously-streaming run ended cleanly (TTL expired,
/// UE exited, browser disconnected, admin cancel). Terminal state for the run.
/// </summary>
public sealed class VisualisationEndedData
{
    [JsonProperty("runId")] public string RunId { get; set; } = "";
    [JsonProperty("reason", NullValueHandling = NullValueHandling.Ignore)]
    public string? Reason { get; set; }
}

/// <summary>
/// Bidirectional opaque WebRTC signalling envelope. PRISM does not parse
/// the Pixel Streaming sub-protocol — the server wraps browser frames
/// into one of these, the agent unwraps and forwards to the local Cirrus
/// WS, and the reverse direction does the same. Exactly one of
/// <see cref="Payload"/> (text) / <see cref="PayloadB64"/> (binary) is
/// set per frame.
/// </summary>
public sealed class SignallingFrameData
{
    [JsonProperty("runId")] public string RunId { get; set; } = "";
    /// <summary>Per-viewer demux key assigned by the server. Each browser
    /// viewer is an independent Wilbur player (1:1). Optional for backward
    /// tolerance — a frame with no viewerId targets the run's sole viewer.</summary>
    [JsonProperty("viewerId",   NullValueHandling = NullValueHandling.Ignore)] public string? ViewerId   { get; set; }
    [JsonProperty("payload",    NullValueHandling = NullValueHandling.Ignore)] public string? Payload    { get; set; }
    [JsonProperty("payloadB64", NullValueHandling = NullValueHandling.Ignore)] public string? PayloadB64 { get; set; }
}

/// <summary>
/// Server -&gt; agent: a browser viewer's signalling socket closed. The
/// agent tears down that viewer's dedicated local Cirrus/Wilbur player WS
/// so the streamer drops the corresponding WebRTC peer.
/// </summary>
public sealed class SignallingViewerCloseData
{
    [JsonProperty("runId")]    public string RunId    { get; set; } = "";
    [JsonProperty("viewerId")] public string ViewerId { get; set; } = "";
}

/// <summary>
/// Server -&gt; agent: authoritative single-controller lock state for one
/// viewer. The agent's per-viewer bridge gates browser-&gt;Cirrus input
/// frames so only the current controller can drive the viewport.
/// </summary>
public sealed class SetViewerControlData
{
    [JsonProperty("runId")]      public string RunId      { get; set; } = "";
    [JsonProperty("viewerId")]   public string ViewerId   { get; set; } = "";
    [JsonProperty("canControl")] public bool   CanControl { get; set; }
}
