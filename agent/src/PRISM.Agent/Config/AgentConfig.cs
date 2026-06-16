using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using PRISM.Contracts;

namespace PRISM.Agent.Config;

public sealed class AgentConfig
{
    public string PrismUrl   { get; set; } = "wss://prism.rebus.industries/ws/agent";
    public string NodeName   { get; set; } = Environment.MachineName;
    public string MachineId  { get; set; } = "auto";
    public int    Slots      { get; set; } = 1;
    public AgentRole[] Roles { get; set; } = new[] { AgentRole.Conversion, AgentRole.Layering, AgentRole.Receive };
    public string? RhinoExecutablePath { get; set; }

    /// <summary>
    /// Which Rhino version to host. Values:
    ///   "auto" (default) — probe for the highest installed version
    ///   "8"             — require Rhino 8 specifically
    ///   "9"             — require Rhino 9 specifically (future; fails fast if not installed)
    /// </summary>
    public string RhinoVersion { get; set; } = "auto";

    /// <summary>
    /// Hard upper bound (seconds) on a single Rhino typed <c>File*.Read</c>
    /// (OBJ / FBX / STL / STEP / DWG / …). A read that exceeds this is
    /// abandoned on its worker thread and the job is failed, so a wedged
    /// importer — classically an FBX file that triggers an interactive
    /// import-options dialog under headless Rhino.Inside — can no longer hang
    /// the agent's WebSocket / heartbeat indefinitely (the field incident that
    /// took the agent process down with WS close code 1006). Clamped to
    /// 30–1800s at use; default 150s sits mid-range of the 120–180s window.
    /// </summary>
    public int RhinoReadTimeoutSeconds { get; set; } = 150;

    /// <summary>
    /// When <c>false</c> (default) the agent refuses FBX <c>pollLayers</c>
    /// (layer-selection) requests with a clear, non-retryable message instead
    /// of attempting the headless FBX layer extraction that wedged the
    /// importer and took the agent down in the field. Convert jobs still
    /// import FBX (batch-mode read + the read watchdog). Flip to <c>true</c>
    /// on a workstation to re-enable FBX layer extraction once the headless
    /// batch-mode FBX read has been verified there; the read remains
    /// watchdog-protected either way.
    /// </summary>
    public bool AllowFbxLayerExtraction { get; set; } = false;

    public string LogDir { get; set; } = @"C:\ProgramData\PRISM.Agent\logs";

    /// <summary>
    /// Port the agent's local web UI binds to.  The UI is a single page served
    /// straight from the agent process for in-place configuration -- see
    /// <c>WebUi/AgentWebUi.cs</c>.  Defaults to 7421.  Set to 0 to disable
    /// the web UI entirely (the tray menu still works).
    /// </summary>
    public int WebUiPort { get; set; } = 7421;

    /// <summary>
    /// When true (default) the web UI binds to <c>0.0.0.0</c>
    /// (Windows: <c>http://+:port/</c>) so operators can reach a workstation's
    /// settings page from any other machine on the LAN.  The Inno installer
    /// pre-registers a URL ACL for the configured port so this works without
    /// the agent process being elevated.
    ///
    /// Set to false to bind to <c>localhost</c> only -- the page is then
    /// reachable from the workstation itself but not from the LAN.
    ///
    /// Note: the local UI is unauthenticated.  Only leave LAN binding on
    /// when the agent is running on a trusted network segment.
    /// </summary>
    public bool WebUiBindAll { get; set; } = true;

    // ---- Visualiser role -------------------------------------------------
    //
    // Phase A scaffold (orchestrator binary lands in Phase F/G). These
    // fields are persisted and exposed in the tray + web UI so operators
    // can pre-stage a workstation for the Visualiser role even though the
    // WS handlers currently ack `accepted: false`. AgentService validates
    // UnrealEngineRoot on startup when AgentRole.Visualiser is set.

    /// <summary>
    /// Filesystem root of the Unreal Engine install the orchestrator should
    /// launch (e.g. <c>C:\Program Files\Epic Games\UE_5.7\</c>). Validated
    /// on agent start when the Visualiser role is enabled — a missing path
    /// logs a structured WARN to the server but does NOT prevent the agent
    /// from running other roles.
    /// </summary>
    public string UnrealEngineRoot { get; set; } = @"C:\Program Files\Epic Games\UE_5.7\";

    /// <summary>
    /// Git tag of the orbit-ue-template build this agent should run when a
    /// <c>startVisualisation</c> envelope arrives without an explicit
    /// <c>templateTag</c>. Tracked in lock-step with the template repo's
    /// release tags; bump after the template publishes a new build.
    ///
    /// <para>
    /// An empty string (the default) means <b>resolve the most recently
    /// published release at pull time</b> — the agent calls
    /// <c>GET /repos/{owner}/{repo}/releases?per_page=1</c> (which returns
    /// the newest release regardless of pre-release status) rather than
    /// pinning any specific version. Set this to a specific tag (e.g.
    /// <c>v1.0.0-ue5.7</c>) to lock every workstation to that release.
    /// </para>
    /// </summary>
    public string UnrealTemplateTag { get; set; } = "";

    /// <summary>
    /// GitHub repository slug (<c>owner/repo</c>) the "pull latest UE
    /// template" feature downloads release archives from. Defaults to the
    /// first-party <c>orbit-ue-template</c> repo. Kept overridable so a fork
    /// or a re-org rename can be pointed at without an agent rebuild. The
    /// old <c>REBUS-ORBIT</c> org still redirects to <c>REBUS-Industries</c>,
    /// so either form resolves.
    /// </summary>
    public string UnrealTemplateRepo { get; set; } = "REBUS-ORBIT/orbit-ue-template";

    /// <summary>
    /// Filesystem root the "pull latest UE template" feature installs pulled
    /// UE projects under. The release archive is extracted and the contained
    /// UE project (the folder holding the <c>.uproject</c>) is copied to
    /// <c>&lt;root&gt;\&lt;ProjectName&gt;</c>; on success
    /// <see cref="VisualiserTemplateProjectPath"/> is repointed there so the
    /// next visualiser run uses the freshly-pulled project. Defaults to
    /// <c>C:\PRISM\Templates</c> (the parent of the default template project
    /// path).
    /// </summary>
    public string VisualiserTemplateRoot { get; set; } = @"C:\PRISM\Templates";

    /// <summary>
    /// GitHub repository slug (<c>owner/repo</c>) the "pull latest UE
    /// template" feature pulls the built <c>OrbitConnector.UE5</c> plug-in
    /// from. Its <c>OrbitConnector-UE5-plugin-&lt;tag&gt;.zip</c> release
    /// asset (connector + bundled <c>orbit-cli.exe</c> + the
    /// <c>glTFRuntime</c> dependency) is merged into the pulled project's
    /// <c>Plugins\</c> so the orchestrator's connector-driven import path
    /// works out of the box. Defaults to the first-party
    /// <c>orbit-connectors</c> repo.
    /// </summary>
    public string OrbitConnectorRepo { get; set; } = "REBUS-ORBIT/orbit-connectors";

    /// <summary>
    /// Pinned <c>orbit-connectors</c> release tag to merge during a template
    /// pull. Empty (the default) means "always merge the connector's latest
    /// release" so a freshly-pulled project ships the newest connector
    /// regardless of which template version was selected.
    /// </summary>
    public string OrbitConnectorTag { get; set; } = "";

    /// <summary>
    /// When true (default) every template pull also downloads the latest
    /// <c>OrbitConnector.UE5</c> plug-in and merges it into the pulled
    /// project's <c>Plugins\</c>. Set false to pull the template project
    /// verbatim (e.g. when the project already vendors a connector build).
    /// </summary>
    public bool VisualiserPullConnector { get; set; } = true;

    /// <summary>
    /// When true (default) a template pull compiles the installed project's
    /// Editor target with UnrealBuildTool as its final step, so the headless
    /// <c>-game</c> Pixel-Streaming launch has module binaries. The pulled
    /// project + the merged <c>OrbitConnector.UE5</c> / <c>glTFRuntime</c>
    /// plug-ins ship C++ <b>source only</b>; without this the orchestrator's
    /// <c>UnrealEditor-Cmd -game</c> exits immediately (<c>ue_game_crashed</c>)
    /// and the operator has to open the project in the editor once to trigger
    /// a compile. Requires a valid <see cref="UnrealEngineRoot"/>. Set false
    /// only for a project known to ship prebuilt binaries.
    /// </summary>
    public bool VisualiserCompileProject { get; set; } = true;

    /// <summary>
    /// Hard cap on simultaneous visualiser sessions on this workstation.
    /// UE + Pixel Streaming is GPU-bound, so multi-session work needs a
    /// real benchmark per box; the safe Phase A default is 1.
    /// </summary>
    public int VisualiserMaxConcurrent { get; set; } = 1;

    /// <summary>
    /// When true (default) the agent verifies a discrete GPU is available
    /// before advertising the Visualiser role to the server. Phase A is
    /// scaffold-only; the actual GPU probe lands in Phase F.
    /// </summary>
    public bool VisualiserGpuCheck { get; set; } = true;

    /// <summary>
    /// DEBUG: when true, the orchestrator launches the UE <c>-game</c>
    /// Pixel-Streaming pass in a VISIBLE windowed process instead of
    /// headless off-screen rendering, so an operator can watch the scene /
    /// viewport / logs on PC01 while a run streams. Pixel Streaming stays
    /// active either way. Default <c>false</c> (headless) so production
    /// behaviour is unchanged. Read at job-launch time, so toggling it takes
    /// effect on the NEXT visualiser run with no agent restart. The window
    /// is only visible if the agent runs in the operator's interactive
    /// desktop session (not as a session-0 Windows service). An externally
    /// set <c>PRISM_VISUALISER_DEBUG_WINDOW</c> env var still works as an
    /// override (OR'd with this flag) — see <c>VisualiserJob</c>.
    /// </summary>
    public bool VisualiserDebugWindow { get; set; } = false;

    /// <summary>
    /// DEBUG: when true, the orchestrator opens the FULL Unreal Editor GUI
    /// (<c>UnrealEditor.exe</c>) on the imported map AND streams the
    /// level-editor viewport to the browser viewer at the same time, instead
    /// of the headless or game-window streaming pass. The operator controls
    /// UE on PC01's interactive desktop (full editor panels) while remote
    /// viewers watch the streamed viewport. SUPERSEDES
    /// <see cref="VisualiserDebugWindow"/> when both are set. Default
    /// <c>false</c> so production behaviour is unchanged. Read at job-launch
    /// time, so toggling it takes effect on the NEXT visualiser run with no
    /// agent restart. The editor window is only visible if the agent runs in
    /// the operator's interactive desktop session (not as a session-0
    /// Windows service). An externally set <c>PRISM_VISUALISER_FULL_EDITOR</c>
    /// env var still works as an override (OR'd with this flag) — see
    /// <c>VisualiserJob</c>.
    /// </summary>
    public bool VisualiserFullEditor { get; set; } = false;

    /// <summary>
    /// Absolute path to the fixed Unreal project the orchestrator opens for the
    /// <b>connector-import / streaming</b> path AND the <see cref="VisualiserFullEditor"/>
    /// debug path. Forwarded to the orchestrator as
    /// <c>PRISM_VISUALISER_TEMPLATE_PROJECT</c> and read at job-launch time, so
    /// a change applies to the NEXT run with no agent restart.
    ///
    /// <para>
    /// <b>Normally set by the agent's "pull latest UE template" feature</b>,
    /// which downloads + compiles the project under
    /// <see cref="VisualiserTemplateRoot"/> (default <c>C:\PRISM\Templates</c>)
    /// and repoints this at <c>C:\PRISM\Templates\&lt;ProjectName&gt;</c>
    /// (e.g. <c>…\REBUSVis</c>) on success. Because that location is local +
    /// already built, the orchestrator opens it <b>in place</b> (no second
    /// copy); a UNC/remote path is still mirrored to a local cache first
    /// (see <c>TemplateProjectProvider</c>).
    /// </para>
    ///
    /// <para>
    /// The code default is the <c>MINIMAL_CUBE</c> baseline (a tiny
    /// Blueprint-only project: cube + floor + lights + PlayerStart, plugins =
    /// PixelStreaming2 + PythonScriptPlugin) so a never-pulled agent can still
    /// prove the Pixel Streaming path without C++ binaries. The legacy AD share
    /// <c>\\fs.ad.rebus.industries\…\REBUS_TEMPLATE</c> is no longer the source
    /// of truth — pull the template locally instead.
    /// </para>
    /// </summary>
    public string VisualiserTemplateProjectPath { get; set; } =
        @"C:\PRISM\Templates\MINIMAL_CUBE";

    /// <summary>
    /// Controls how the streaming (NON full-editor) path imports the ORBIT
    /// model:
    /// <list type="bullet">
    ///   <item><description>
    ///     <c>null</c> (default) — <b>auto</b>: the orchestrator uses the
    ///     bundled <c>OrbitConnector.UE5</c> plug-in to pull + load the model
    ///     inside the streamed UE instance when the configured fixed project
    ///     (<see cref="VisualiserTemplateProjectPath"/>) ships the connector
    ///     plug-in + <c>orbit-cli</c>; otherwise it falls back to the built-in
    ///     Interchange importer (receive → glTF → <c>import_orbit.py</c>).
    ///   </description></item>
    ///   <item><description>
    ///     <c>true</c> — force the connector path (warns + still attempts it if
    ///     the plug-in isn't detected; the import fails inside UE if it's truly
    ///     absent).
    ///   </description></item>
    ///   <item><description>
    ///     <c>false</c> — force the legacy Interchange path regardless of the
    ///     project.
    ///   </description></item>
    /// </list>
    /// Forwarded to the orchestrator as <c>PRISM_VISUALISER_CONNECTOR_IMPORT</c>
    /// (<c>1</c>/<c>0</c>) only when non-null; when null the orchestrator
    /// auto-detects. Read at job-launch time so a change applies on the next run
    /// with no agent restart. An externally-set env var overrides this value.
    /// </summary>
    public bool? VisualiserConnectorImport { get; set; } = null;

    /// <summary>
    /// Base URL of the external "Portal" service the Unreal plug-ins connect
    /// to (forwarded to UE as <c>-PortalUrl="&lt;url&gt;"</c>). Not a secret —
    /// echoed normally in the agent web UI / WS state. Forwarded to the
    /// orchestrator as <c>PRISM_PORTAL_URL</c>; read at job-launch time so a
    /// change applies on the NEXT visualiser run with no agent restart.
    /// </summary>
    public string PortalUrl { get; set; } = "https://app.rebus.industries";

    /// <summary>
    /// REBUS Portal API key the Unreal plug-ins authenticate to the Portal
    /// with (forwarded to UE as <c>-RebusApiKey=&lt;key&gt;</c>). This is a
    /// SECRET: it is persisted to the local agent-config.json but is NEVER
    /// echoed back in the web UI / WS state (the UI only sees a
    /// <c>rebusApiKeySet</c> boolean) and is NEVER written to any log — the
    /// agent forwards it to the orchestrator via <c>PRISM_REBUS_API_KEY</c>
    /// and the orchestrator passes it to UE on the command line only, exactly
    /// mirroring the existing <c>-OrbitToken=</c> handling. Empty (the
    /// default) means "unset" — the orchestrator omits the
    /// <c>-RebusApiKey=</c> flag entirely.
    ///
    /// <para>
    /// Update semantics (see <see cref="AgentControlPlane.ApplyAsync"/>): a
    /// <c>null</c> or blank/whitespace value in a <see cref="ConfigUpdate"/>
    /// LEAVES THE STORED KEY UNCHANGED, so the web UI — which never receives
    /// the value back and therefore cannot round-trip it — does not wipe the
    /// key on an unrelated settings save. Only a non-blank value replaces it.
    /// </para>
    /// </summary>
    public string RebusApiKey { get; set; } = "";

    /// <summary>
    /// GitHub token (PAT) the agent uses to authenticate its GitHub REST API
    /// calls for the "pull latest UE template" feature (resolve the template +
    /// <c>OrbitConnector.UE5</c> releases/assets, and list releases for the
    /// version picker). Authenticated calls raise GitHub's rate limit from 60
    /// to 5000 requests/hour and are required for private template/connector
    /// repos. <b>Takes precedence over</b> the <c>PRISM_GITHUB_TOKEN</c> /
    /// <c>GITHUB_TOKEN</c> environment variables (which remain as a fallback),
    /// so an operator can fix a rate-limit without touching OS env vars — it is
    /// read at pull time from config, no agent restart needed.
    ///
    /// <para>
    /// This is a SECRET: it is persisted to the local agent-config.json but is
    /// NEVER echoed back in the web UI / WS state (the UI only sees a
    /// <c>gitHubTokenSet</c> boolean) and is NEVER written to any log — exactly
    /// mirroring <see cref="RebusApiKey"/>.
    /// </para>
    ///
    /// <para>
    /// Update semantics (see <see cref="AgentControlPlane.ApplyAsync"/>): a
    /// <c>null</c> or blank/whitespace value in a <see cref="ConfigUpdate"/>
    /// LEAVES THE STORED TOKEN UNCHANGED (the web UI never receives the value
    /// back and so cannot round-trip it). Only a non-blank value replaces it.
    /// </para>
    /// </summary>
    public string GitHubToken { get; set; } = "";

    /// <summary>
    /// Optional override for the on-disk path of
    /// <c>PRISM.Visualiser.Orchestrator.exe</c>. When set, takes
    /// precedence over the agent installer's bundled copy at
    /// <c>{InstallDir}\Visualiser\PRISM.Visualiser.Orchestrator.exe</c>.
    /// Leave null/empty in production — the installer ships the
    /// orchestrator in lock-step with the agent. Useful when running
    /// the agent from a dev build of the agent against a separately-
    /// built orchestrator (or when smoke-testing a hotfix orchestrator
    /// against the installed agent).
    /// </summary>
    public string? VisualiserOrchestratorPath { get; set; }

    // ---- Installed-template provenance (reported to the server) ---------
    //
    // Set by AgentControlPlane.PullTemplate on a successful pull and used as
    // the fallback when the on-disk .prism-template.json marker at
    // VisualiserTemplateProjectPath is missing. TemplateMarker.Resolve reads
    // these; the agent reports the resolved tag(s) on `hello` so the admin
    // Workstations page + agent web UI can show which UE template release is
    // installed. Empty = unknown.

    /// <summary>
    /// Release tag of the <c>orbit-ue-template</c> build currently installed
    /// at <see cref="VisualiserTemplateProjectPath"/>. Persisted as a fallback
    /// for the on-disk marker; empty when no pull has run on this workstation.
    /// </summary>
    public string VisualiserTemplateVersion { get; set; } = "";

    /// <summary>
    /// Release tag of the <c>OrbitConnector.UE5</c> plug-in merged into the
    /// currently-installed template project (companion to
    /// <see cref="VisualiserTemplateVersion"/>). Empty when the connector
    /// merge was skipped or no pull has run.
    /// </summary>
    public string VisualiserConnectorVersion { get; set; } = "";

    /// <summary>
    /// Path the config was loaded from (or last saved to). Not persisted to JSON.
    /// </summary>
    [JsonIgnore]
    public string? LoadedPath { get; private set; }

    // -------------------------------------------------------------------------
    // Serializer options shared across Load / Save
    // -------------------------------------------------------------------------
    static readonly JsonSerializerOptions _readOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling         = JsonCommentHandling.Skip,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    static readonly JsonSerializerOptions _writeOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    // -------------------------------------------------------------------------
    // Load
    // -------------------------------------------------------------------------
    public static AgentConfig Load(string? path = null)
    {
        path ??= ResolveLoadPath();

        AgentConfig cfg;
        if (!File.Exists(path))
        {
            cfg = new AgentConfig();
        }
        else
        {
            // File.ReadAllText respects BOMs when an explicit encoding is
            // not provided — but the resulting string still contains
            // U+FEFF if the file was saved with BOM by a Windows editor
            // (PowerShell's Set-Content, classic Notepad). Read raw
            // bytes and decode with a permissive UTF8Encoding that
            // detects + strips the BOM marker so downstream string
            // properties (UnrealEngineRoot in particular) don't carry
            // an invisible leading character into Process env vars.
            var bytes = File.ReadAllBytes(path);
            var json = StripUtf8Bom(bytes);
            cfg = JsonSerializer.Deserialize<AgentConfig>(json, _readOpts)
                  ?? throw new InvalidOperationException($"failed to parse {path}");
        }

        cfg.LoadedPath = path;
        cfg.MachineId  = ResolveMachineId(cfg.MachineId);
        cfg.UnrealEngineRoot = SanitizePathLike(cfg.UnrealEngineRoot)
            ?? string.Empty;
        cfg.VisualiserOrchestratorPath = SanitizePathLike(cfg.VisualiserOrchestratorPath);
        cfg.VisualiserTemplateRoot = SanitizePathLike(cfg.VisualiserTemplateRoot)
            ?? string.Empty;
        return cfg;
    }

    /// <summary>
    /// Decode <paramref name="bytes"/> as UTF-8 and drop a leading BOM
    /// if present. Editors on Windows often save .json with a UTF-8 BOM
    /// preamble (EF BB BF); System.Text.Json's parser tolerates that at
    /// the top of the document, but the BOM character can survive
    /// inside string values when the JSON tokenizer doesn't see it as
    /// document-level. Strip explicitly here so the deserialized
    /// values are clean.
    /// </summary>
    static string StripUtf8Bom(byte[] bytes)
    {
        const byte b0 = 0xEF, b1 = 0xBB, b2 = 0xBF;
        if (bytes.Length >= 3 && bytes[0] == b0 && bytes[1] == b1 && bytes[2] == b2)
        {
            return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        }
        return Encoding.UTF8.GetString(bytes);
    }

    /// <summary>
    /// Strip leading/trailing whitespace + invisible unicode characters
    /// (BOM, zero-width spaces/joiners) from a path-like string. The
    /// SettingsForm text box and JSON copy-paste have both historically
    /// allowed these characters to sneak into <see cref="UnrealEngineRoot"/>
    /// and similar properties. Returning a sanitized value here means
    /// every consumer (AgentService validation, VisualiserJob env-var
    /// population, the WS payload reporting the agent state to the
    /// server) sees the same clean form without needing to repeat the
    /// normalization.
    /// </summary>
    public static string? SanitizePathLike(string? value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        var trimmed = value.Trim();
        if (trimmed.Length == 0) return string.Empty;
        var start = 0;
        while (start < trimmed.Length && IsInvisible(trimmed[start])) start++;
        var end = trimmed.Length - 1;
        while (end >= start && IsInvisible(trimmed[end])) end--;
        if (start > end) return string.Empty;
        return trimmed.Substring(start, end - start + 1);

        static bool IsInvisible(char ch) =>
            ch == '\uFEFF' || ch == '\u200B' || ch == '\u200C' || ch == '\u200D';
    }

    // -------------------------------------------------------------------------
    // Save -- always targets ProgramData so a non-elevated agent (the common
    // case when the scheduled task runs as the interactive workstation user)
    // can persist setting changes.  Program Files is read-only for non-admin
    // users, so the legacy "save next to the EXE" behaviour broke the web
    // UI's Save button with a 500 ACL error on workstations whose login user
    // is not a local administrator.
    // -------------------------------------------------------------------------
    public void Save(string? path = null)
    {
        var savePath = path ?? ProgramDataConfigPath;
        var dir = Path.GetDirectoryName(savePath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var json = JsonSerializer.Serialize(this, _writeOpts);

        try
        {
            File.WriteAllText(savePath, json, Encoding.UTF8);
        }
        catch (UnauthorizedAccessException) when (path is null)
        {
            // Last-ditch fallback to %LOCALAPPDATA% so the agent never silently
            // throws away an operator's config edit, even on locked-down boxes
            // where ProgramData is restricted.
            var local = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PRISM.Agent", "agent-config.json");
            Directory.CreateDirectory(Path.GetDirectoryName(local)!);
            File.WriteAllText(local, json, Encoding.UTF8);
            savePath = local;
        }

        LoadedPath = savePath;

        // Best-effort cleanup: if the previous on-disk config lived next to
        // the EXE (legacy v0.1.x layout), remove it so subsequent loads
        // don't see a stale Program Files copy.
        try
        {
            var legacy = Path.Combine(AppContext.BaseDirectory, "agent-config.json");
            if (!string.Equals(legacy, savePath, StringComparison.OrdinalIgnoreCase) &&
                File.Exists(legacy))
            {
                File.Delete(legacy);
            }
        }
        catch
        {
            // Non-fatal; the next Save() will retry, and Load() prefers
            // ProgramData anyway so the legacy file is harmless if left.
        }
    }

    // -------------------------------------------------------------------------
    // Path resolution
    // -------------------------------------------------------------------------
    static string ProgramDataConfigPath =>
        Path.Combine(@"C:\ProgramData\PRISM.Agent", "agent-config.json");

    /// <summary>
    /// Pick the on-disk config to load.  ProgramData wins because Save() now
    /// targets it; the EXE-adjacent legacy path is checked only as a fallback
    /// for v0.1.x installs that wrote their initial config to Program Files.
    /// </summary>
    static string ResolveLoadPath()
    {
        var programData = ProgramDataConfigPath;
        if (File.Exists(programData)) return programData;

        var legacy = Path.Combine(AppContext.BaseDirectory, "agent-config.json");
        if (File.Exists(legacy)) return legacy;

        // No config yet -- caller will create one with defaults and the next
        // Save() lands in ProgramData.
        return programData;
    }

    static string ResolveMachineId(string raw)
    {
        if (!string.Equals(raw, "auto", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(raw))
            return raw;

        // Persist a stable GUID in ProgramData so re-installs don't churn workstation rows.
        var dir = @"C:\ProgramData\PRISM.Agent";
        Directory.CreateDirectory(dir);
        var idPath = Path.Combine(dir, "machine-id");
        if (File.Exists(idPath))
        {
            var existing = File.ReadAllText(idPath).Trim();
            if (Guid.TryParse(existing, out _)) return existing;
        }
        var id = Guid.NewGuid().ToString();
        File.WriteAllText(idPath, id);
        return id;
    }
}
