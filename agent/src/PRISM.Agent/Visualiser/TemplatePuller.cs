using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace PRISM.Agent.Visualiser;

/// <summary>
/// Downloads the latest (or a pinned) release of the
/// <c>orbit-ue-template</c> GitHub repository and installs the contained
/// Unreal Engine project into the workstation's visualiser template root
/// (default <c>C:\PRISM\Templates</c>).
///
/// <para>
/// Flow: resolve the release via the GitHub API → pick a downloadable
/// archive (a <c>.zip</c> release asset when present, else the source
/// <c>zipball</c>) → stream it to a temp file → extract → locate the
/// <c>.uproject</c> to find the project root → atomically replace
/// <c>&lt;root&gt;\&lt;ProjectName&gt;</c> with the pulled project. The
/// caller (control plane) repoints
/// <see cref="Config.AgentConfig.VisualiserTemplateProjectPath"/> at the
/// returned path so the next visualiser run uses the fresh project.
/// </para>
///
/// <para>
/// Mirrors the orchestrator's <c>TemplateFetcher</c> intent but lives in
/// the agent because the agent — not the orchestrator — owns the
/// operator-triggered "pull" action exposed on the tray / local web UI and
/// the admin Workstations page. Public repos resolve anonymously; a
/// <c>PRISM_GITHUB_TOKEN</c> / <c>GITHUB_TOKEN</c> env var (if set) is sent
/// as a bearer so a private template repo also works.
/// </para>
/// </summary>
public static class TemplatePuller
{
    /// <summary>Outcome of a successful pull.</summary>
    /// <param name="ProjectName">Folder name the project was installed as (the <c>.uproject</c> base name).</param>
    /// <param name="ProjectPath">Absolute path of the installed project directory (holds the <c>.uproject</c>).</param>
    /// <param name="UprojectPath">Absolute path of the installed <c>.uproject</c> file.</param>
    /// <param name="Tag">The resolved release tag that was pulled.</param>
    /// <param name="SourceUrl">The archive URL that was downloaded.</param>
    /// <param name="ConnectorTag">Resolved OrbitConnector release tag merged into the project's <c>Plugins\</c>, or null when the connector merge was skipped.</param>
    /// <param name="ConnectorPlugins">Plug-in folder names merged from the connector package (e.g. <c>OrbitConnector</c>, <c>glTFRuntime</c>); empty when skipped.</param>
    public sealed record PullResult(
        string ProjectName,
        string ProjectPath,
        string UprojectPath,
        string Tag,
        string SourceUrl,
        string? ConnectorTag,
        IReadOnlyList<string> ConnectorPlugins);

    /// <summary>One published release of a template/connector repo, for the version picker.</summary>
    /// <param name="Tag">The git tag (e.g. <c>v0.1.0-ue5.7-scaffold</c>).</param>
    /// <param name="Name">Human-readable release name (falls back to the tag).</param>
    /// <param name="PublishedAt">ISO-8601 publish timestamp, or null for drafts.</param>
    /// <param name="Prerelease">True when GitHub flagged the release as a pre-release.</param>
    /// <param name="HasArchive">True when the release exposes a downloadable archive (a <c>.zip</c> asset or the source zipball).</param>
    public sealed record ReleaseInfo(
        string Tag,
        string? Name,
        string? PublishedAt,
        bool Prerelease,
        bool HasArchive);

    /// <summary>
    /// Pull + install a template. Throws <see cref="TemplatePullException"/>
    /// for any actionable failure (bad repo slug, no release, no archive,
    /// no <c>.uproject</c> in the archive, filesystem error).
    /// </summary>
    /// <param name="repoSlug">GitHub <c>owner/repo</c> slug.</param>
    /// <param name="requestedTag">Caller/admin-pinned tag; takes precedence.</param>
    /// <param name="configuredTag">The agent's configured default tag.</param>
    /// <param name="templateRoot">Root dir to install the project under.</param>
    /// <param name="connectorRepo">GitHub <c>owner/repo</c> slug of the connectors repo (its <c>OrbitConnector-UE5-plugin-*.zip</c> release asset is merged into the pulled project's <c>Plugins\</c>).</param>
    /// <param name="connectorTag">Pinned connector release tag; empty/null pulls the connector's latest release.</param>
    /// <param name="pullConnector">When false the connector merge is skipped (project pulled as-is).</param>
    /// <param name="progress">Optional human-readable progress sink (web UI status line).</param>
    public static async Task<PullResult> PullAsync(
        string repoSlug,
        string? requestedTag,
        string? configuredTag,
        string templateRoot,
        string? connectorRepo,
        string? connectorTag,
        bool pullConnector,
        IProgress<string>? progress,
        ILogger log,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(repoSlug) || !repoSlug.Contains('/'))
            throw new TemplatePullException(
                $"Invalid template repo slug '{repoSlug}'. Expected 'owner/repo'.");
        if (string.IsNullOrWhiteSpace(templateRoot))
            throw new TemplatePullException("VisualiserTemplateRoot is not configured.");

        repoSlug = repoSlug.Trim().Trim('/');
        var requested = (requestedTag ?? "").Trim();
        var configured = (configuredTag ?? "").Trim();

        using var http = CreateHttpClient();

        // 1. Resolve the release.
        var effective = requested.Length > 0 ? requested : configured;
        progress?.Report(effective.Length > 0 ? $"resolving release {effective}…" : "resolving latest release…");
        var (resolvedTag, archiveUrl) = await ResolveReleaseAsync(
                http, repoSlug, requested, configured, progress, log, ct)
            .ConfigureAwait(false);
        log.LogInformation(
            "template pull: repo={Repo} tag={Tag} archive={Archive}",
            repoSlug, resolvedTag, archiveUrl);

        // 2. Download the archive to a temp file.
        var workDir = Path.Combine(Path.GetTempPath(), "PRISM.Agent.TemplatePull", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        var zipPath = Path.Combine(workDir, "template.zip");
        try
        {
            progress?.Report($"downloading {resolvedTag}…");
            await DownloadAsync(http, archiveUrl, zipPath, progress, log, ct).ConfigureAwait(false);

            // 3. Extract.
            progress?.Report("extracting…");
            var extractDir = Path.Combine(workDir, "extract");
            Directory.CreateDirectory(extractDir);
            ZipFile.ExtractToDirectory(zipPath, extractDir);

            // 4. Locate the .uproject → project root.
            var uproject = FindUproject(extractDir)
                ?? throw new TemplatePullException(
                    $"The {repoSlug} archive for {resolvedTag} did not contain a .uproject file.");
            var projectRoot = Path.GetDirectoryName(uproject)!;
            var projectName = Path.GetFileNameWithoutExtension(uproject);
            log.LogInformation(
                "template pull: found project '{Name}' at {Root}", projectName, projectRoot);

            // 5. Merge the connector plug-in into the project's Plugins\ BEFORE
            //    installing, so the atomic swap deposits project + connector
            //    together (a connector failure aborts the whole pull cleanly
            //    rather than leaving a connector-less project on disk).
            string? connectorResolvedTag = null;
            IReadOnlyList<string> connectorPlugins = Array.Empty<string>();
            if (pullConnector)
            {
                (connectorResolvedTag, connectorPlugins) = await MergeConnectorAsync(
                        http, connectorRepo, connectorTag, projectRoot, workDir, progress, log, ct)
                    .ConfigureAwait(false);
            }

            // 6. Install: replace <root>\<ProjectName> atomically.
            Directory.CreateDirectory(templateRoot);
            var dest = Path.Combine(templateRoot, projectName);
            progress?.Report($"installing to {dest}…");
            InstallProject(projectRoot, dest, log);

            var installedUproject = Path.Combine(dest, Path.GetFileName(uproject));
            log.LogInformation(
                "template pull: installed {Name} tag={Tag} connector={Connector} -> {Dest}",
                projectName, resolvedTag, connectorResolvedTag ?? "<skipped>", dest);
            var connectorNote = connectorResolvedTag is { Length: > 0 }
                ? $" + connector {connectorResolvedTag}"
                : "";
            progress?.Report($"done: {projectName} ({resolvedTag}){connectorNote}");

            return new PullResult(
                projectName, dest, installedUproject, resolvedTag, archiveUrl,
                connectorResolvedTag, connectorPlugins);
        }
        finally
        {
            // Best-effort cleanup of the temp work dir.
            try { if (Directory.Exists(workDir)) Directory.Delete(workDir, recursive: true); }
            catch (Exception ex) { log.LogDebug(ex, "template pull: temp cleanup failed for {Dir}", workDir); }
        }
    }

    // ------------------------------------------------------------------

    /// <summary>
    /// List the published releases of <paramref name="repoSlug"/> (newest
    /// first) so an operator can pick a specific version to pull. Reuses the
    /// same anonymous/token-authenticated GitHub client as <see cref="PullAsync"/>.
    /// Returns an empty list when the repo has no releases; throws
    /// <see cref="TemplatePullException"/> for an invalid slug or a non-404
    /// HTTP failure (e.g. a private repo without a token → 404 is treated as
    /// "no releases").
    /// </summary>
    public static async Task<IReadOnlyList<ReleaseInfo>> ListReleasesAsync(
        string repoSlug, ILogger log, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(repoSlug) || !repoSlug.Contains('/'))
            throw new TemplatePullException(
                $"Invalid template repo slug '{repoSlug}'. Expected 'owner/repo'.");
        repoSlug = repoSlug.Trim().Trim('/');

        using var http = CreateHttpClient();
        var apiUrl = $"https://api.github.com/repos/{repoSlug}/releases?per_page=50";
        using var resp = await http.GetAsync(apiUrl, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound)
            return Array.Empty<ReleaseInfo>();
        if (!resp.IsSuccessStatusCode)
            throw new TemplatePullException(
                $"GitHub API GET {apiUrl} failed: HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}.");

        var json = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Array)
            return Array.Empty<ReleaseInfo>();

        var list = new List<ReleaseInfo>();
        foreach (var r in doc.RootElement.EnumerateArray())
        {
            // Skip drafts — they have no published archive a workstation can pull.
            if (r.TryGetProperty("draft", out var draft) &&
                draft.ValueKind == JsonValueKind.True)
                continue;

            var tag = r.TryGetProperty("tag_name", out var tn) ? tn.GetString() : null;
            if (string.IsNullOrWhiteSpace(tag)) continue;

            var name = r.TryGetProperty("name", out var nm) ? nm.GetString() : null;
            var publishedAt = r.TryGetProperty("published_at", out var pa) ? pa.GetString() : null;
            var prerelease = r.TryGetProperty("prerelease", out var pr) &&
                             pr.ValueKind == JsonValueKind.True;

            var hasZipAsset = r.TryGetProperty("assets", out var assets) &&
                              assets.ValueKind == JsonValueKind.Array &&
                              assets.EnumerateArray().Any(a =>
                                  a.TryGetProperty("name", out var an) &&
                                  an.GetString() is { } s &&
                                  s.EndsWith(".zip", StringComparison.OrdinalIgnoreCase));
            var hasZipball = r.TryGetProperty("zipball_url", out var zb) &&
                             !string.IsNullOrEmpty(zb.GetString());

            list.Add(new ReleaseInfo(
                tag!, string.IsNullOrWhiteSpace(name) ? tag : name,
                publishedAt, prerelease, hasZipAsset || hasZipball));
        }

        log.LogInformation("template releases: {Repo} → {Count} release(s)", repoSlug, list.Count);
        return list;
    }

    /// <summary>
    /// Build the GitHub HTTP client shared by every call: 10-min timeout,
    /// JSON accept header, PRISM user-agent, and a bearer token from
    /// <c>PRISM_GITHUB_TOKEN</c>/<c>GITHUB_TOKEN</c> when set (so private
    /// repos resolve). Caller owns disposal.
    /// </summary>
    static HttpClient CreateHttpClient()
    {
        var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true })
        {
            Timeout = TimeSpan.FromMinutes(10),
        };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PRISM.Agent (+https://github.com/REBUS-ORBIT/prism)");
        http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        var token = Environment.GetEnvironmentVariable("PRISM_GITHUB_TOKEN")
                    ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN");
        if (!string.IsNullOrWhiteSpace(token))
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token.Trim());
        return http;
    }

    /// <summary>
    /// Resolve a release to <c>(tag, archiveUrl)</c>.
    ///
    /// <para>Precedence + forgiveness:</para>
    /// <list type="bullet">
    ///   <item><description>
    ///     A <paramref name="requestedTag"/> (operator-typed / admin-pinned)
    ///     takes priority and <b>must exist</b> — a 404 is a hard error.
    ///   </description></item>
    ///   <item><description>
    ///     Otherwise the agent's <paramref name="configuredTag"/> is tried as a
    ///     <b>preference</b>: if that release does not exist (e.g. the default
    ///     points at an as-yet-unpublished artist tag), we fall back to the
    ///     repo's <c>releases/latest</c> with a warning rather than failing.
    ///   </description></item>
    ///   <item><description>
    ///     With neither set, <c>releases/latest</c> is used directly.
    ///   </description></item>
    /// </list>
    /// Prefers a <c>.zip</c> release asset; falls back to the source <c>zipball</c>.
    /// </summary>
    static async Task<(string Tag, string ArchiveUrl)> ResolveReleaseAsync(
        HttpClient http, string repoSlug, string requestedTag, string configuredTag,
        IProgress<string>? progress, ILogger log, CancellationToken ct)
    {
        var explicitTag = requestedTag.Length > 0;
        var tag = explicitTag ? requestedTag : configuredTag;

        var hit = await TryGetReleaseAsync(http, repoSlug, tag.Length > 0 ? tag : null, log, ct)
            .ConfigureAwait(false);
        if (hit is { } found) return found;

        // The requested/configured/latest lookup 404'd.
        if (explicitTag)
        {
            throw new TemplatePullException(
                $"No release tagged '{tag}' found in {repoSlug} (HTTP 404). " +
                "Check the tag, clear it to pull the latest release, or set PRISM_GITHUB_TOKEN if the repo is private.");
        }

        if (tag.Length > 0)
        {
            // Configured default missing — degrade to latest instead of failing.
            log.LogWarning(
                "template pull: configured tag '{Tag}' not found in {Repo}; falling back to the latest release",
                tag, repoSlug);
            progress?.Report($"tag {tag} not found — falling back to latest…");
            var latest = await TryGetReleaseAsync(http, repoSlug, null, log, ct).ConfigureAwait(false);
            if (latest is { } l) return l;
        }

        throw new TemplatePullException(
            $"No releases found in {repoSlug} (HTTP 404). " +
            "If the repo is private, set PRISM_GITHUB_TOKEN.");
    }

    /// <summary>
    /// GET a single release (a specific <paramref name="tag"/>, or the latest
    /// when null) and pick its archive URL. Returns <c>null</c> when the
    /// release / tag does not exist (HTTP 404) so the caller can fall back;
    /// throws <see cref="TemplatePullException"/> for any other HTTP failure
    /// or when a found release exposes no downloadable archive.
    /// </summary>
    static async Task<(string Tag, string ArchiveUrl)?> TryGetReleaseAsync(
        HttpClient http, string repoSlug, string? tag, ILogger log, CancellationToken ct)
    {
        var apiUrl = tag is { Length: > 0 }
            ? $"https://api.github.com/repos/{repoSlug}/releases/tags/{Uri.EscapeDataString(tag)}"
            : $"https://api.github.com/repos/{repoSlug}/releases/latest";

        using var resp = await http.GetAsync(apiUrl, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        if (!resp.IsSuccessStatusCode)
        {
            throw new TemplatePullException(
                $"GitHub API GET {apiUrl} failed: HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}.");
        }

        var json = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var resolvedTag = root.TryGetProperty("tag_name", out var tn) ? tn.GetString() : null;
        if (string.IsNullOrEmpty(resolvedTag)) resolvedTag = tag is { Length: > 0 } ? tag : "latest";

        // Prefer a .zip release asset (the orbit-ue-template build CI uploads
        // orbit-ue-template-<tag>.zip). Otherwise fall back to the source zipball.
        if (root.TryGetProperty("assets", out var assets) &&
            assets.ValueKind == JsonValueKind.Array)
        {
            foreach (var a in assets.EnumerateArray())
            {
                var name = a.TryGetProperty("name", out var n) ? n.GetString() : null;
                if (name != null &&
                    name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) &&
                    a.TryGetProperty("browser_download_url", out var bu) &&
                    bu.GetString() is { Length: > 0 } url)
                {
                    return (resolvedTag, url);
                }
            }
        }

        if (root.TryGetProperty("zipball_url", out var zb) &&
            zb.GetString() is { Length: > 0 } zipball)
        {
            log.LogInformation(
                "template pull: no .zip release asset on {Tag}; using source zipball", resolvedTag);
            return (resolvedTag, zipball);
        }

        throw new TemplatePullException(
            $"Release {resolvedTag} in {repoSlug} has no .zip asset and no source archive.");
    }

    // ---- Connector (OrbitConnector.UE5 plug-in) merge ------------------

    /// <summary>
    /// Default connectors repo slug used when the agent config leaves it
    /// blank. The old <c>REBUS-ORBIT</c> org still redirects to
    /// <c>REBUS-Industries</c>, so either form resolves via the API.
    /// </summary>
    public const string DefaultConnectorRepo = "REBUS-ORBIT/orbit-connectors";

    /// <summary>
    /// Download the connectors repo's UE5 plug-in package
    /// (<c>OrbitConnector-UE5-plugin-&lt;tag&gt;.zip</c>) for the pinned tag (or
    /// the connector's latest release when blank), extract it, and copy every
    /// contained plug-in folder (each holding a <c>.uplugin</c> — typically
    /// <c>OrbitConnector</c> + its <c>glTFRuntime</c> dependency, with the
    /// bundled <c>orbit-cli.exe</c>) into <paramref name="projectRoot"/>'s
    /// <c>Plugins\</c> directory. This is what makes the pulled project usable
    /// by the orchestrator's connector-driven import path
    /// (<c>OrbitConnectorLocator.Detect</c>). Throws
    /// <see cref="TemplatePullException"/> on any actionable failure so the
    /// whole pull aborts cleanly (no connector-less project is installed).
    /// </summary>
    static async Task<(string Tag, IReadOnlyList<string> Plugins)> MergeConnectorAsync(
        HttpClient http, string? connectorRepo, string? connectorTag,
        string projectRoot, string workDir,
        IProgress<string>? progress, ILogger log, CancellationToken ct)
    {
        var repo = string.IsNullOrWhiteSpace(connectorRepo)
            ? DefaultConnectorRepo
            : connectorRepo.Trim().Trim('/');
        if (!repo.Contains('/'))
            throw new TemplatePullException(
                $"Invalid connector repo slug '{repo}'. Expected 'owner/repo'.");
        var pinned = (connectorTag ?? "").Trim();

        progress?.Report(pinned.Length > 0
            ? $"resolving connector {pinned}…"
            : "resolving latest connector…");
        var (tag, assetUrl, assetName) = await ResolveConnectorAssetAsync(
                http, repo, pinned.Length > 0 ? pinned : null, log, ct)
            .ConfigureAwait(false);
        log.LogInformation(
            "template pull: connector repo={Repo} tag={Tag} asset={Asset}", repo, tag, assetName);

        var zipPath = Path.Combine(workDir, "connector.zip");
        progress?.Report($"downloading connector {tag}…");
        await DownloadAsync(http, assetUrl, zipPath, progress, log, ct).ConfigureAwait(false);

        progress?.Report("merging connector plug-in…");
        var extractDir = Path.Combine(workDir, "connector");
        Directory.CreateDirectory(extractDir);
        ZipFile.ExtractToDirectory(zipPath, extractDir);

        // Every top-level folder that owns a .uplugin is a plug-in to install.
        // Dedupe by destination folder name (handles wrapped/unwrapped zips).
        var upluginFiles = Directory
            .EnumerateFiles(extractDir, "*.uplugin", SearchOption.AllDirectories)
            .ToList();
        if (upluginFiles.Count == 0)
            throw new TemplatePullException(
                $"Connector asset '{assetName}' ({repo} {tag}) contained no .uplugin plug-in folder.");

        var pluginsRoot = Path.Combine(projectRoot, "Plugins");
        Directory.CreateDirectory(pluginsRoot);

        var installed = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var uplugin in upluginFiles)
        {
            var pluginSrc = Path.GetDirectoryName(uplugin)!;
            var pluginName = Path.GetFileName(pluginSrc);
            if (!seen.Add(pluginName)) continue;

            var pluginDest = Path.Combine(pluginsRoot, pluginName);
            if (Directory.Exists(pluginDest)) Directory.Delete(pluginDest, recursive: true);
            CopyDirectory(pluginSrc, pluginDest);
            installed.Add(pluginName);
            log.LogInformation("template pull: merged connector plug-in '{Plugin}'", pluginName);
        }

        progress?.Report($"connector {tag} merged ({string.Join(", ", installed)})");
        return (tag, installed);
    }

    /// <summary>
    /// GET the connector release (a specific <paramref name="tag"/>, or the
    /// latest when null) and pick its UE5 plug-in <c>.zip</c> asset
    /// (<c>OrbitConnector-UE5-plugin-*.zip</c>). A pinned tag that 404s is a
    /// hard error (no silent fallback); a missing UE5-plugin asset on an
    /// otherwise-valid release is also an error (the source zipball does NOT
    /// contain the built plug-in + bundled CLI).
    /// </summary>
    static async Task<(string Tag, string AssetUrl, string AssetName)> ResolveConnectorAssetAsync(
        HttpClient http, string repoSlug, string? tag, ILogger log, CancellationToken ct)
    {
        var apiUrl = tag is { Length: > 0 }
            ? $"https://api.github.com/repos/{repoSlug}/releases/tags/{Uri.EscapeDataString(tag)}"
            : $"https://api.github.com/repos/{repoSlug}/releases/latest";

        using var resp = await http.GetAsync(apiUrl, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound)
        {
            throw new TemplatePullException(tag is { Length: > 0 }
                ? $"No connector release tagged '{tag}' found in {repoSlug} (HTTP 404). " +
                  "Check the tag, clear it to pull the latest connector, or set PRISM_GITHUB_TOKEN if the repo is private."
                : $"No connector releases found in {repoSlug} (HTTP 404). " +
                  "If the repo is private, set PRISM_GITHUB_TOKEN.");
        }
        if (!resp.IsSuccessStatusCode)
            throw new TemplatePullException(
                $"GitHub API GET {apiUrl} failed: HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}.");

        var json = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var resolvedTag = root.TryGetProperty("tag_name", out var tn) ? tn.GetString() : null;
        if (string.IsNullOrEmpty(resolvedTag)) resolvedTag = tag is { Length: > 0 } ? tag : "latest";

        if (root.TryGetProperty("assets", out var assets) &&
            assets.ValueKind == JsonValueKind.Array)
        {
            // Prefer the UE5 plug-in package; fall back to any zip whose name
            // names both "ue5" and "plugin" (defends against minor naming drift).
            string? bestUrl = null, bestName = null;
            foreach (var a in assets.EnumerateArray())
            {
                var name = a.TryGetProperty("name", out var n) ? n.GetString() : null;
                if (name is null ||
                    !name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) ||
                    !a.TryGetProperty("browser_download_url", out var bu) ||
                    bu.GetString() is not { Length: > 0 } url)
                    continue;

                var isUe5Plugin =
                    name.Contains("UE5-plugin", StringComparison.OrdinalIgnoreCase) ||
                    (name.Contains("ue5", StringComparison.OrdinalIgnoreCase) &&
                     name.Contains("plugin", StringComparison.OrdinalIgnoreCase));
                if (isUe5Plugin) return (resolvedTag!, url, name);

                // Remember the first zip as a last resort only if nothing better shows up.
                bestUrl ??= url;
                bestName ??= name;
            }

            if (bestUrl is not null)
            {
                log.LogWarning(
                    "template pull: connector release {Tag} has no UE5-plugin zip; using '{Asset}'",
                    resolvedTag, bestName);
                return (resolvedTag!, bestUrl, bestName!);
            }
        }

        throw new TemplatePullException(
            $"Connector release {resolvedTag} in {repoSlug} has no UE5 plug-in .zip asset " +
            "(expected OrbitConnector-UE5-plugin-<tag>.zip). The source zipball does not contain the built plug-in.");
    }

    static async Task DownloadAsync(
        HttpClient http, string url, string destPath,
        IProgress<string>? progress, ILogger log, CancellationToken ct)
    {
        using var resp = await http
            .GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();

        var total = resp.Content.Headers.ContentLength ?? 0;
        await using var src = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await using var dst = new FileStream(
            destPath, FileMode.Create, FileAccess.Write, FileShare.Read, 64 * 1024, useAsync: true);

        var buf = new byte[64 * 1024];
        long downloaded = 0;
        int lastPct = -1;
        int read;
        while ((read = await src.ReadAsync(buf, ct).ConfigureAwait(false)) > 0)
        {
            await dst.WriteAsync(buf.AsMemory(0, read), ct).ConfigureAwait(false);
            downloaded += read;
            if (total > 0)
            {
                var pct = (int)(downloaded * 100 / total);
                if (pct >= lastPct + 10)
                {
                    lastPct = pct;
                    progress?.Report($"downloading… {pct}%");
                }
            }
        }
        await dst.FlushAsync(ct).ConfigureAwait(false);
        log.LogInformation("template pull: downloaded {Bytes} bytes from {Url}", downloaded, url);
    }

    /// <summary>
    /// Find the <c>.uproject</c> nearest the archive root. GitHub source
    /// zipballs wrap everything in a top-level <c>owner-repo-sha/</c> folder,
    /// and release-asset zips may place the project at root or one level
    /// down — so we pick the shallowest <c>.uproject</c> (fewest path
    /// separators), which is the actual project descriptor rather than any
    /// nested plugin/sample project.
    /// </summary>
    static string? FindUproject(string extractDir)
    {
        return Directory
            .EnumerateFiles(extractDir, "*.uproject", SearchOption.AllDirectories)
            .OrderBy(p => p.Count(c => c == Path.DirectorySeparatorChar))
            .ThenBy(p => p.Length)
            .FirstOrDefault();
    }

    /// <summary>
    /// Replace <paramref name="dest"/> with the contents of
    /// <paramref name="projectRoot"/>. Staged via a sibling temp dir then an
    /// atomic-ish swap so an interrupted copy never leaves a half-written
    /// project where the previous good one used to be.
    /// </summary>
    static void InstallProject(string projectRoot, string dest, ILogger log)
    {
        var parent = Path.GetDirectoryName(dest)!;
        var staging = Path.Combine(parent, "." + Path.GetFileName(dest) + ".pull-" + Guid.NewGuid().ToString("N")[..8]);

        // Stage a fresh copy first (works across volumes; the extract temp
        // lives under %TEMP% which is often a different drive to C:\PRISM).
        CopyDirectory(projectRoot, staging);

        // Swap: remove the old project, move the staged copy into place.
        var backup = dest + ".old-" + Guid.NewGuid().ToString("N")[..8];
        try
        {
            if (Directory.Exists(dest)) Directory.Move(dest, backup);
            Directory.Move(staging, dest);
        }
        catch
        {
            // Roll back: restore the old project if the move failed midway.
            try { if (!Directory.Exists(dest) && Directory.Exists(backup)) Directory.Move(backup, dest); }
            catch (Exception ex) { log.LogWarning(ex, "template pull: rollback of {Dest} failed", dest); }
            try { if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true); } catch { /* nop */ }
            throw;
        }

        try { if (Directory.Exists(backup)) Directory.Delete(backup, recursive: true); }
        catch (Exception ex) { log.LogDebug(ex, "template pull: could not delete backup {Backup}", backup); }
    }

    static void CopyDirectory(string sourceDir, string destDir)
    {
        Directory.CreateDirectory(destDir);
        foreach (var dir in Directory.EnumerateDirectories(sourceDir, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(dir.Replace(sourceDir, destDir));
        }
        foreach (var file in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
        {
            File.Copy(file, file.Replace(sourceDir, destDir), overwrite: true);
        }
    }
}

/// <summary>Actionable failure during a template pull (surfaced to the operator).</summary>
public sealed class TemplatePullException : Exception
{
    public TemplatePullException(string message) : base(message) { }
    public TemplatePullException(string message, Exception inner) : base(message, inner) { }
}
