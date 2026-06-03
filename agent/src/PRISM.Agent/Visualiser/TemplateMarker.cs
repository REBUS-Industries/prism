using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using PRISM.Agent.Config;

namespace PRISM.Agent.Visualiser;

/// <summary>
/// Durable record of WHICH <c>orbit-ue-template</c> release is currently
/// installed at a workstation's visualiser template project path.
///
/// <para>
/// A successful <see cref="TemplatePuller.PullAsync"/> drops a small
/// <c>.prism-template.json</c> marker in the installed project root (the
/// folder holding the <c>.uproject</c>). The marker survives agent
/// restarts and is independent of the transient in-memory
/// <c>TemplatePullStatus</c>, so the agent can always answer "what version
/// is installed?" on the very next <c>hello</c> — even after a reboot when
/// no pull has run this session.
/// </para>
///
/// <para>
/// Resolution order (see <see cref="Resolve"/>): read the marker from the
/// configured <see cref="AgentConfig.VisualiserTemplateProjectPath"/>;
/// fall back to the persisted <see cref="AgentConfig.VisualiserTemplateVersion"/>
/// config value; otherwise the version is simply unknown (null) and the
/// server / UIs render it as "unknown" / "—".
/// </para>
/// </summary>
public static class TemplateMarker
{
    /// <summary>Marker file name written into the installed project root.</summary>
    public const string FileName = ".prism-template.json";

    /// <summary>Parsed contents of a <c>.prism-template.json</c> marker.</summary>
    public sealed class MarkerData
    {
        [JsonPropertyName("templateTag")]  public string?  TemplateTag  { get; set; }
        [JsonPropertyName("connectorTag")] public string?  ConnectorTag { get; set; }
        [JsonPropertyName("pulledAt")]     public string?  PulledAt     { get; set; }
        [JsonPropertyName("repo")]         public string?  Repo         { get; set; }
    }

    static readonly JsonSerializerOptions _opts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>
    /// Write (overwrite) the marker into <paramref name="projectPath"/>.
    /// Best-effort: a failure is logged at WARN and swallowed so it never
    /// fails an otherwise-successful pull.
    /// </summary>
    public static void Write(
        string projectPath, string templateTag, string? connectorTag, string? repo, ILogger log)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(projectPath) || !Directory.Exists(projectPath))
            {
                log.LogWarning("template marker: project path '{Path}' missing — marker not written", projectPath);
                return;
            }
            var marker = new MarkerData
            {
                TemplateTag  = templateTag,
                ConnectorTag = string.IsNullOrWhiteSpace(connectorTag) ? null : connectorTag,
                PulledAt     = DateTime.UtcNow.ToString("o"),
                Repo         = string.IsNullOrWhiteSpace(repo) ? null : repo,
            };
            var path = Path.Combine(projectPath, FileName);
            File.WriteAllText(path, JsonSerializer.Serialize(marker, _opts));
            log.LogInformation("template marker: wrote {Path} (tag={Tag})", path, templateTag);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "template marker: failed to write marker into {Path}", projectPath);
        }
    }

    /// <summary>
    /// Read the marker from <paramref name="projectPath"/>, or null when the
    /// path is empty, missing, or the marker is absent / unparseable.
    /// </summary>
    public static MarkerData? Read(string? projectPath)
    {
        if (string.IsNullOrWhiteSpace(projectPath)) return null;
        try
        {
            var path = Path.Combine(projectPath, FileName);
            if (!File.Exists(path)) return null;
            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<MarkerData>(json, _opts);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Resolve the currently-installed template + connector tags for an
    /// agent. Prefers the on-disk marker at
    /// <see cref="AgentConfig.VisualiserTemplateProjectPath"/>; falls back to
    /// the persisted config values; returns <c>(null, null)</c> when nothing
    /// is known.
    /// </summary>
    public static (string? TemplateTag, string? ConnectorTag) Resolve(AgentConfig cfg)
    {
        var marker = Read(cfg.VisualiserTemplateProjectPath);

        // The on-disk marker is authoritative. The persisted AgentConfig values
        // are a fallback ONLY for a legacy project that predates markers — and
        // only trustworthy while that project still physically exists at the
        // configured path. If the path is gone (or was repointed to a project
        // we have no marker for), the persisted tag describes a DIFFERENT /
        // previous install and would be reported as a stale, incorrect
        // "installed" version — so prefer reporting unknown (null) over a lie.
        var projectExists = !string.IsNullOrWhiteSpace(cfg.VisualiserTemplateProjectPath)
                            && Directory.Exists(cfg.VisualiserTemplateProjectPath);

        var templateTag = !string.IsNullOrWhiteSpace(marker?.TemplateTag)
            ? marker!.TemplateTag
            : (projectExists && !string.IsNullOrWhiteSpace(cfg.VisualiserTemplateVersion)
                ? cfg.VisualiserTemplateVersion
                : null);
        var connectorTag = !string.IsNullOrWhiteSpace(marker?.ConnectorTag)
            ? marker!.ConnectorTag
            : (projectExists && !string.IsNullOrWhiteSpace(cfg.VisualiserConnectorVersion)
                ? cfg.VisualiserConnectorVersion
                : null);
        return (templateTag, connectorTag);
    }
}
