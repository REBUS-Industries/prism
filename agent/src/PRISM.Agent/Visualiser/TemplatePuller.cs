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
    /// Result of <see cref="ListReleasesAsync"/>. When <see cref="NotModified"/>
    /// is true the caller's cached list is still current (GitHub returned 304
    /// to the conditional request — which does NOT count against the rate
    /// limit) and <see cref="Releases"/> is empty. Otherwise <see cref="ETag"/>
    /// is the value to send as <c>If-None-Match</c> on the next refresh.
    /// </summary>
    public sealed record ReleaseListResult(
        IReadOnlyList<ReleaseInfo> Releases,
        string? ETag,
        bool NotModified);

    /// <summary>
    /// One connector ref (release tag or branch) for the connector version
    /// picker. The <see cref="Ref"/> value is what is passed as the
    /// <c>connectorRef</c> to the pull; branches are prefixed with
    /// <c>branch:</c> so the pull flow can distinguish them from tags and
    /// fetch their source zipball rather than trying a release API endpoint.
    /// </summary>
    /// <param name="Ref">
    /// Value to pass as <c>connectorRef</c> (tag, e.g. <c>v0.1.28</c>, or
    /// <c>branch:feat/my-branch</c> for a branch).
    /// </param>
    /// <param name="DisplayName">Human-readable label for the UI dropdown.</param>
    /// <param name="IsBranch">True when this is a branch ref (not a release).</param>
    /// <param name="IsPrerelease">True when GitHub flagged the release as a pre-release.</param>
    /// <param name="HasBuiltAsset">
    /// True when the release has a pre-built <c>OrbitConnector-UE5-plugin-*.zip</c>
    /// asset. Always false for branches (source-only, compiled by UBT).
    /// </param>
    /// <param name="PublishedAt">ISO-8601 publish timestamp for releases; null for branches.</param>
    public sealed record ConnectorRefInfo(
        string Ref,
        string? DisplayName,
        bool IsBranch,
        bool IsPrerelease,
        bool HasBuiltAsset,
        string? PublishedAt);

    /// <summary>
    /// Result of <see cref="ListConnectorRefsAsync"/>. <see cref="NotModified"/>
    /// mirrors <see cref="ReleaseListResult.NotModified"/>.
    /// </summary>
    public sealed record ConnectorRefsResult(
        IReadOnlyList<ConnectorRefInfo> Refs,
        string? ETag,
        bool NotModified);

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
    /// <param name="compileProject">When true (default) the installed project's Editor target is compiled via UnrealBuildTool so the headless <c>-game</c> launch has module binaries. Requires a valid <paramref name="engineRoot"/>.</param>
    /// <param name="engineRoot">Unreal Engine install root (holds <c>Engine\Build\BatchFiles\Build.bat</c>); used to compile the project. Required when <paramref name="compileProject"/> is true.</param>
    /// <param name="gitHubToken">Configured GitHub token (<c>AgentConfig.GitHubToken</c>); takes precedence over the <c>PRISM_GITHUB_TOKEN</c>/<c>GITHUB_TOKEN</c> env vars. Null/blank → fall back to env, else anonymous.</param>
    /// <param name="progress">Optional human-readable progress sink (web UI status line).</param>
    public static async Task<PullResult> PullAsync(
        string repoSlug,
        string? requestedTag,
        string? configuredTag,
        string templateRoot,
        string? connectorRepo,
        string? connectorTag,
        bool pullConnector,
        bool compileProject,
        string? engineRoot,
        string? gitHubToken,
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

        using var http = CreateHttpClient(gitHubToken);

        // 1. Resolve the release.
        var effective = requested.Length > 0 ? requested : configured;
        progress?.Report(effective.Length > 0 ? $"resolving release {effective}…" : "resolving latest release…");
        var (resolvedTag, archiveUrl) = await ResolveReleaseAsync(
                http, repoSlug, requested, configured, gitHubToken, progress, log, ct)
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
                        http, connectorRepo, connectorTag, projectRoot, workDir, gitHubToken, progress, log, ct)
                    .ConfigureAwait(false);
            }

            // 6. Install: replace <root>\<ProjectName> atomically.
            Directory.CreateDirectory(templateRoot);
            var dest = Path.Combine(templateRoot, projectName);
            progress?.Report($"installing to {dest}…");
            InstallProject(projectRoot, dest, log);

            var installedUproject = Path.Combine(dest, Path.GetFileName(uproject));

            // 7. Compile the installed project's Editor target so the headless
            //    -game launch has module binaries. The pulled project + the
            //    merged OrbitConnector.UE5 plug-in ship C++ SOURCE ONLY (no
            //    Binaries), so without this step UnrealEditor-Cmd -game exits
            //    immediately (ue_game_crashed) — the operator otherwise has to
            //    open the project in the editor once to trigger a compile.
            //    Compiled in place (post-swap): UBT writes Binaries/Intermediate
            //    into the project tree, and building the moved tree afterwards
            //    would invalidate UBT's absolute-path makefile — so we build the
            //    final installed location directly.
            var compiled = false;
            if (compileProject)
            {
                compiled = await CompileProjectAsync(
                        dest, installedUproject, projectName, engineRoot, progress, log, ct)
                    .ConfigureAwait(false);
            }

            log.LogInformation(
                "template pull: installed {Name} tag={Tag} connector={Connector} compiled={Compiled} -> {Dest}",
                projectName, resolvedTag, connectorResolvedTag ?? "<skipped>", compiled, dest);

            // Record WHICH release is now physically installed as a durable
            // .prism-template.json marker in the project root. The INSTALLER
            // writes it (not just the control-plane caller) so every project
            // this code deposits carries the marker — making the on-disk marker
            // the single source of truth for "what UE template is installed
            // here". TemplateMarker.Resolve reads it on every `hello`; the
            // persisted AgentConfig values are only a fallback for legacy
            // projects that predate markers.
            TemplateMarker.Write(dest, resolvedTag, connectorResolvedTag, repoSlug, log);

            var connectorNote = connectorResolvedTag is { Length: > 0 }
                ? $" + connector {connectorResolvedTag}"
                : "";
            var compiledNote = compiled ? " + compiled" : "";
            progress?.Report($"done: {projectName} ({resolvedTag}){connectorNote}{compiledNote}");

            return new PullResult(
                projectName, dest, installedUproject, resolvedTag, archiveUrl,
                connectorResolvedTag, connectorPlugins);
        }
        finally
        {
            // Best-effort cleanup of the temp work dir. The extracted git
            // zipball carries read-only objects, so force-delete (strip
            // read-only + retry) rather than a plain recursive delete.
            try { ForceDelete(workDir, log); }
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
    public static async Task<ReleaseListResult> ListReleasesAsync(
        string repoSlug, string? etag, string? gitHubToken, ILogger log, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(repoSlug) || !repoSlug.Contains('/'))
            throw new TemplatePullException(
                $"Invalid template repo slug '{repoSlug}'. Expected 'owner/repo'.");
        repoSlug = repoSlug.Trim().Trim('/');

        using var http = CreateHttpClient(gitHubToken);
        var apiUrl = $"https://api.github.com/repos/{repoSlug}/releases?per_page=50";
        // Conditional request: a 304 (cache still valid) does NOT count against
        // the GitHub rate limit, so polling the picker is effectively free.
        using var req = new HttpRequestMessage(HttpMethod.Get, apiUrl);
        if (!string.IsNullOrWhiteSpace(etag))
            req.Headers.TryAddWithoutValidation("If-None-Match", etag);

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotModified)
            return new ReleaseListResult(Array.Empty<ReleaseInfo>(), etag, NotModified: true);
        if (resp.StatusCode == HttpStatusCode.NotFound)
            return new ReleaseListResult(Array.Empty<ReleaseInfo>(), null, NotModified: false);
        if (!resp.IsSuccessStatusCode)
            throw HttpFailure(resp, apiUrl, gitHubToken);

        var newEtag = resp.Headers.ETag?.Tag;
        var json = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Array)
            return new ReleaseListResult(Array.Empty<ReleaseInfo>(), newEtag, NotModified: false);

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
        return new ReleaseListResult(list, newEtag, NotModified: false);
    }

    /// <summary>
    /// List the connector repo's releases (including pre-releases) plus all
    /// branches, combined into the <see cref="ConnectorRefInfo"/> list used by
    /// the connector version picker dropdown in the agent web UI.
    ///
    /// <para>
    /// <b>Releases</b> are fetched from
    /// <c>GET /repos/{owner}/{repo}/releases?per_page=50</c>; pre-releases are
    /// included (unlike the template picker which only shows stable tags in its
    /// dropdown, the connector picker surfaces everything so the operator can
    /// select a dev pre-release). A conditional request with the supplied
    /// <paramref name="etag"/> is made, so a 304 does not count against the
    /// GitHub rate limit.
    /// </para>
    ///
    /// <para>
    /// <b>Branches</b> are fetched from
    /// <c>GET /repos/{owner}/{repo}/branches?per_page=100</c>. Branch refs are
    /// prefixed with <c>branch:</c> in <see cref="ConnectorRefInfo.Ref"/> so the
    /// pull flow knows to download the source zipball rather than the release API
    /// endpoint. Source builds need UBT to compile, so
    /// <see cref="ConnectorRefInfo.HasBuiltAsset"/> is <c>false</c> for all branches.
    /// </para>
    ///
    /// <para>
    /// A 404 (private repo without a token) is treated as "nothing" rather than
    /// an error so the UI can degrade gracefully.
    /// </para>
    /// </summary>
    public static async Task<ConnectorRefsResult> ListConnectorRefsAsync(
        string repoSlug, string? etag, string? gitHubToken, ILogger log, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(repoSlug) || !repoSlug.Contains('/'))
            throw new TemplatePullException(
                $"Invalid connector repo slug '{repoSlug}'. Expected 'owner/repo'.");
        repoSlug = repoSlug.Trim().Trim('/');

        using var http = CreateHttpClient(gitHubToken);

        // --- Releases (including pre-releases) ---
        var releasesUrl = $"https://api.github.com/repos/{repoSlug}/releases?per_page=50";
        using var relReq = new HttpRequestMessage(HttpMethod.Get, releasesUrl);
        if (!string.IsNullOrWhiteSpace(etag))
            relReq.Headers.TryAddWithoutValidation("If-None-Match", etag);

        using var relResp = await http.SendAsync(relReq, ct).ConfigureAwait(false);

        string? newEtag = null;
        var refs = new List<ConnectorRefInfo>();

        if (relResp.StatusCode == HttpStatusCode.NotModified)
            return new ConnectorRefsResult(Array.Empty<ConnectorRefInfo>(), etag, NotModified: true);

        if (relResp.StatusCode == HttpStatusCode.NotFound)
        {
            log.LogWarning("connector refs: no releases found in {Repo} (404)", repoSlug);
            // Still try branches below.
        }
        else if (relResp.IsSuccessStatusCode)
        {
            newEtag = relResp.Headers.ETag?.Tag;
            var relJson = await relResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var relDoc = JsonDocument.Parse(relJson);
            if (relDoc.RootElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var r in relDoc.RootElement.EnumerateArray())
                {
                    // Skip drafts.
                    if (r.TryGetProperty("draft", out var draft) && draft.ValueKind == JsonValueKind.True)
                        continue;
                    var tag = r.TryGetProperty("tag_name", out var tn) ? tn.GetString() : null;
                    if (string.IsNullOrWhiteSpace(tag)) continue;
                    var name = r.TryGetProperty("name", out var nm) ? nm.GetString() : null;
                    var publishedAt = r.TryGetProperty("published_at", out var pa) ? pa.GetString() : null;
                    var prerelease = r.TryGetProperty("prerelease", out var pr) && pr.ValueKind == JsonValueKind.True;
                    // Does this release have a pre-built UE5 plugin zip?
                    var hasBuilt = r.TryGetProperty("assets", out var assets) &&
                                   assets.ValueKind == JsonValueKind.Array &&
                                   assets.EnumerateArray().Any(a =>
                                   {
                                       var n = a.TryGetProperty("name", out var an) ? an.GetString() : null;
                                       return n != null && (
                                           n.Contains("UE5-plugin", StringComparison.OrdinalIgnoreCase) ||
                                           (n.Contains("ue5", StringComparison.OrdinalIgnoreCase) &&
                                            n.Contains("plugin", StringComparison.OrdinalIgnoreCase)));
                                   });

                    var display = string.IsNullOrWhiteSpace(name) || name == tag ? tag : $"{name} — {tag}";
                    if (prerelease) display += " (pre)";
                    if (!hasBuilt) display += " (source-only)";
                    refs.Add(new ConnectorRefInfo(tag!, display, IsBranch: false, prerelease, hasBuilt, publishedAt));
                }
            }
            log.LogInformation("connector refs: {Repo} → {Count} release(s)", repoSlug, refs.Count);
        }

        // --- Branches ---
        var branchesUrl = $"https://api.github.com/repos/{repoSlug}/branches?per_page=100";
        using var brResp = await http.GetAsync(branchesUrl, ct).ConfigureAwait(false);
        if (brResp.IsSuccessStatusCode)
        {
            var brJson = await brResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var brDoc = JsonDocument.Parse(brJson);
            if (brDoc.RootElement.ValueKind == JsonValueKind.Array)
            {
                var branchRefs = new List<ConnectorRefInfo>();
                foreach (var b in brDoc.RootElement.EnumerateArray())
                {
                    var name = b.TryGetProperty("name", out var n) ? n.GetString() : null;
                    if (string.IsNullOrWhiteSpace(name)) continue;
                    branchRefs.Add(new ConnectorRefInfo(
                        $"branch:{name}", $"{name} (branch, source)", IsBranch: true,
                        IsPrerelease: false, HasBuiltAsset: false, PublishedAt: null));
                }
                refs.AddRange(branchRefs);
                log.LogInformation("connector refs: {Repo} → {Count} branch(es)", repoSlug, branchRefs.Count);
            }
        }

        return new ConnectorRefsResult(refs, newEtag, NotModified: false);
    }

    /// <summary>
    /// Resolve the effective GitHub token: the agent-configured
    /// <paramref name="configuredToken"/> (from <c>AgentConfig.GitHubToken</c>,
    /// settable in the web UI) takes precedence, then the
    /// <c>PRISM_GITHUB_TOKEN</c> / <c>GITHUB_TOKEN</c> environment variables.
    /// Returns null when none is set (anonymous, 60 req/hr).
    /// </summary>
    static string? ResolveToken(string? configuredToken)
    {
        if (!string.IsNullOrWhiteSpace(configuredToken)) return configuredToken.Trim();
        var env = Environment.GetEnvironmentVariable("PRISM_GITHUB_TOKEN")
                  ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN");
        return string.IsNullOrWhiteSpace(env) ? null : env.Trim();
    }

    /// <summary>
    /// Build the GitHub HTTP client shared by every call: 10-min timeout,
    /// JSON accept header, PRISM user-agent, and a bearer token resolved via
    /// <see cref="ResolveToken"/> (configured token wins over env). Caller owns
    /// disposal.
    /// </summary>
    static HttpClient CreateHttpClient(string? configuredToken = null)
    {
        var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true })
        {
            Timeout = TimeSpan.FromMinutes(10),
        };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PRISM.Agent (+https://github.com/REBUS-ORBIT/prism)");
        http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        var token = ResolveToken(configuredToken);
        if (token is not null)
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return http;
    }

    /// <summary>True when a GitHub token is available (configured token or env var).</summary>
    static bool HasGitHubToken(string? configuredToken) => ResolveToken(configuredToken) is not null;

    /// <summary>
    /// Build a <see cref="TemplatePullException"/> for a non-success GitHub
    /// response. A 403/429 with <c>x-ratelimit-remaining: 0</c> is recognised
    /// as a <b>rate limit</b> (not a generic failure) and the message tells the
    /// operator to set <c>PRISM_GITHUB_TOKEN</c> and when the limit resets.
    /// </summary>
    static TemplatePullException HttpFailure(HttpResponseMessage resp, string apiUrl, string? configuredToken)
    {
        var status = (int)resp.StatusCode;
        if (status == 401)
        {
            return new TemplatePullException(
                $"GitHub token rejected (401 Bad credentials) for {apiUrl}. " +
                "Update the GitHub token in the agent web UI (Visualiser card) or refresh " +
                "PRISM_GITHUB_TOKEN / GITHUB_TOKEN on this workstation — the current token " +
                "may be expired or lack read access to the repo.",
                isRateLimit: false);
        }

        var remaining = FirstHeader(resp, "x-ratelimit-remaining");
        var isRateLimited = (status == 403 || status == 429) &&
                            string.Equals(remaining, "0", StringComparison.Ordinal);
        if (isRateLimited)
        {
            var advice = HasGitHubToken(configuredToken)
                ? "A GitHub token is set but the limit was still hit — the token may be invalid/expired, " +
                  "or authenticated usage is unusually high."
                : "The agent is making UNAUTHENTICATED GitHub requests (60/hour per IP). Set a GitHub token " +
                  "(a PAT with public_repo scope; repo scope if the template/connector repos are private) to " +
                  "raise the limit to 5000/hour — enter it in the agent web UI's \"GitHub token\" field (no " +
                  "restart needed), or set the PRISM_GITHUB_TOKEN / GITHUB_TOKEN environment variable.";
            return new TemplatePullException(
                $"GitHub API rate limit exceeded (HTTP {status}) for {apiUrl}. {advice}{DescribeReset(resp)}",
                isRateLimit: true);
        }
        return new TemplatePullException(
            $"GitHub API GET {apiUrl} failed: HTTP {status} {resp.ReasonPhrase}.");
    }

    /// <summary>Human-readable reset hint from <c>x-ratelimit-reset</c> (unix secs) or <c>Retry-After</c>.</summary>
    static string DescribeReset(HttpResponseMessage resp)
    {
        var reset = FirstHeader(resp, "x-ratelimit-reset");
        if (long.TryParse(reset, out var unix))
        {
            var when = DateTimeOffset.FromUnixTimeSeconds(unix);
            var mins = Math.Max(0, (when - DateTimeOffset.UtcNow).TotalMinutes);
            return $" Limit resets at {when.UtcDateTime:yyyy-MM-dd HH:mm:ss}Z (~{mins:F0} min).";
        }
        var retry = FirstHeader(resp, "Retry-After");
        return int.TryParse(retry, out var secs) ? $" Retry after ~{secs}s." : string.Empty;
    }

    static string? FirstHeader(HttpResponseMessage resp, string name) =>
        resp.Headers.TryGetValues(name, out var values) ? values.FirstOrDefault() : null;

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
        string? gitHubToken, IProgress<string>? progress, ILogger log, CancellationToken ct)
    {
        var explicitTag = requestedTag.Length > 0;
        var tag = explicitTag ? requestedTag : configuredTag;

        var hit = await TryGetReleaseAsync(http, repoSlug, tag.Length > 0 ? tag : null, gitHubToken, log, ct)
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
            var latest = await TryGetReleaseAsync(http, repoSlug, null, gitHubToken, log, ct).ConfigureAwait(false);
            if (latest is { } l) return l;
        }

        throw new TemplatePullException(
            $"No releases found in {repoSlug} (HTTP 404). " +
            "If the repo is private, set PRISM_GITHUB_TOKEN.");
    }

    /// <summary>
    /// GET a single release (a specific <paramref name="tag"/>, or the most
    /// recently published release when null) and pick its archive URL. Returns
    /// <c>null</c> when the release / tag does not exist (HTTP 404) so the
    /// caller can fall back; throws <see cref="TemplatePullException"/> for any
    /// other HTTP failure or when a found release exposes no downloadable archive.
    ///
    /// <para>
    /// When <paramref name="tag"/> is null, this method uses
    /// <c>GET /repos/{owner}/{repo}/releases?per_page=1</c> (sorted by
    /// publication date descending) rather than <c>/releases/latest</c>.
    /// The <c>/releases/latest</c> endpoint skips pre-releases, which can
    /// cause the agent to resolve a much older stable release instead of the
    /// most recently published one (e.g. returning v1.0.0 instead of v1.0.96
    /// when v1.0.96 is flagged as a pre-release on GitHub). The list endpoint
    /// returns all non-draft releases in publish order, so the first entry is
    /// always the most recently published regardless of pre-release status.
    /// </para>
    /// </summary>
    static async Task<(string Tag, string ArchiveUrl)?> TryGetReleaseAsync(
        HttpClient http, string repoSlug, string? tag, string? gitHubToken, ILogger log, CancellationToken ct)
    {
        // For a specific tag: standard releases/tags/{tag} endpoint.
        // For "latest": use releases?per_page=1 so pre-releases are included
        // (releases/latest skips pre-releases, which silently returns a much
        // older stable release when newer versions are flagged pre-release).
        bool listEndpoint = tag is not { Length: > 0 };
        var apiUrl = listEndpoint
            ? $"https://api.github.com/repos/{repoSlug}/releases?per_page=1"
            : $"https://api.github.com/repos/{repoSlug}/releases/tags/{Uri.EscapeDataString(tag!)}";

        using var resp = await http.GetAsync(apiUrl, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        if (!resp.IsSuccessStatusCode)
            throw HttpFailure(resp, apiUrl, gitHubToken);

        var json = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);

        // The list endpoint returns an array; the tags endpoint returns an object.
        JsonElement root;
        if (listEndpoint)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Array ||
                doc.RootElement.GetArrayLength() == 0)
                return null; // Repo has no releases.
            root = doc.RootElement[0];
        }
        else
        {
            root = doc.RootElement;
        }

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
        string projectRoot, string workDir, string? gitHubToken,
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
                http, repo, pinned.Length > 0 ? pinned : null, gitHubToken, log, ct)
            .ConfigureAwait(false);
        var isSourceBuild = assetName is "[branch source]" or "[source zipball]";
        log.LogInformation(
            "template pull: connector repo={Repo} ref={Tag} asset={Asset} sourceBuild={Source}",
            repo, tag, assetName, isSourceBuild);
        if (isSourceBuild)
            progress?.Report($"downloading connector source for {tag} (will compile)…");

        var zipPath = Path.Combine(workDir, "connector.zip");
        if (!isSourceBuild)
            progress?.Report($"downloading connector {tag}…");
        await DownloadAsync(http, assetUrl, zipPath, progress, log, ct).ConfigureAwait(false);

        progress?.Report(isSourceBuild ? "merging connector source…" : "merging connector plug-in…");
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
            if (Directory.Exists(pluginDest)) ForceDelete(pluginDest, log);
            CopyDirectory(pluginSrc, pluginDest);
            installed.Add(pluginName);
            log.LogInformation("template pull: merged connector plug-in '{Plugin}'", pluginName);
        }

        progress?.Report($"connector {tag} merged ({string.Join(", ", installed)})");
        return (tag, installed);
    }

    /// <summary>
    /// Prefix that the connector version picker places in front of branch ref
    /// values to distinguish them from release tags.
    /// </summary>
    public const string BranchRefPrefix = "branch:";

    /// <summary>
    /// GET the connector asset (release or branch source) for the given ref.
    ///
    /// <para>Resolution order:</para>
    /// <list type="number">
    ///   <item><description>
    ///     If <paramref name="tag"/> starts with <see cref="BranchRefPrefix"/>
    ///     (e.g. <c>branch:feat/my-branch</c>), strip the prefix and use the
    ///     GitHub source zipball for that branch directly — no release API lookup.
    ///     The zipball contains the C++ plug-in source; UBT compiles it as part
    ///     of the template compile step.
    ///   </description></item>
    ///   <item><description>
    ///     Otherwise try the release API for the tag (or latest when null/empty).
    ///     Prefer a pre-built <c>OrbitConnector-UE5-plugin-*.zip</c> asset.
    ///   </description></item>
    ///   <item><description>
    ///     If the release tag 404s (e.g. an untagged SHA or a branch name passed
    ///     without the <c>branch:</c> prefix), fall back to the source zipball for
    ///     that ref (same path as explicit branch refs) and log a warning.
    ///   </description></item>
    /// </list>
    ///
    /// <para>
    /// The returned <c>AssetName</c> uses a <c>[branch source]</c> / <c>[source
    /// zipball]</c> sentinel when the source path is taken so
    /// <see cref="MergeConnectorAsync"/> can log whether the merge used a
    /// pre-built binary or C++ source (which will be compiled by UBT).
    /// </para>
    /// </summary>
    static async Task<(string Tag, string AssetUrl, string AssetName)> ResolveConnectorAssetAsync(
        HttpClient http, string repoSlug, string? tag, string? gitHubToken, ILogger log, CancellationToken ct)
    {
        // 1. Explicit branch ref: use source zipball immediately.
        if (tag is { Length: > 0 } && tag.StartsWith(BranchRefPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var branchName = tag[BranchRefPrefix.Length..].Trim();
            if (string.IsNullOrWhiteSpace(branchName))
                throw new TemplatePullException($"Invalid branch ref '{tag}' — branch name is empty.");
            var zipballUrl = $"https://api.github.com/repos/{repoSlug}/zipball/{Uri.EscapeDataString(branchName)}";
            log.LogInformation(
                "template pull: connector branch ref '{Branch}' → source zipball (will compile)", branchName);
            return ($"branch:{branchName}", zipballUrl, "[branch source]");
        }

        // 2. Try the release API for the tag (or most recently published release).
        // Use releases?per_page=1 (not /releases/latest) when resolving "latest"
        // so pre-releases are included — /releases/latest skips them and can return
        // a much older stable version instead of the newest release.
        bool listEndpoint = tag is not { Length: > 0 };
        var apiUrl = listEndpoint
            ? $"https://api.github.com/repos/{repoSlug}/releases?per_page=1"
            : $"https://api.github.com/repos/{repoSlug}/releases/tags/{Uri.EscapeDataString(tag!)}";

        using var resp = await http.GetAsync(apiUrl, ct).ConfigureAwait(false);

        if (resp.StatusCode == HttpStatusCode.NotFound)
        {
            if (listEndpoint)
                throw new TemplatePullException(
                    $"No connector releases found in {repoSlug} (HTTP 404). " +
                    "If the repo is private, set PRISM_GITHUB_TOKEN.");

            // 3. Tag not found as a release — fall back to source zipball (handles
            //    branch names passed without the branch: prefix and short SHAs).
            log.LogWarning(
                "template pull: connector ref '{Ref}' not found as a release in {Repo}; " +
                "falling back to source zipball (will compile with UBT)",
                tag, repoSlug);
            var zipballUrl = $"https://api.github.com/repos/{repoSlug}/zipball/{Uri.EscapeDataString(tag!)}";
            return (tag!, zipballUrl, "[source zipball]");
        }

        if (!resp.IsSuccessStatusCode)
            throw HttpFailure(resp, apiUrl, gitHubToken);

        var json = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);

        // The list endpoint returns an array; extract the first (most recent) element.
        JsonElement root;
        if (listEndpoint)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Array ||
                doc.RootElement.GetArrayLength() == 0)
                throw new TemplatePullException(
                    $"No connector releases found in {repoSlug}. " +
                    "If the repo is private, set PRISM_GITHUB_TOKEN.");
            root = doc.RootElement[0];
        }
        else
        {
            root = doc.RootElement;
        }

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

        // Release exists but has no zip asset — fall back to its own source zipball.
        if (root.TryGetProperty("zipball_url", out var zb) &&
            zb.GetString() is { Length: > 0 } sourceZip)
        {
            log.LogWarning(
                "template pull: connector release {Tag} has no UE5-plugin zip asset; " +
                "using source zipball (will compile with UBT)", resolvedTag);
            return (resolvedTag!, sourceZip, "[source zipball]");
        }

        throw new TemplatePullException(
            $"Connector release {resolvedTag} in {repoSlug} has no UE5 plug-in .zip asset " +
            "and no source zipball. Check the release or choose a different connector version.");
    }

    // ---- Compile (UnrealBuildTool Editor target) -----------------------

    /// <summary>
    /// Compile the installed project's <b>Editor</b> target with
    /// UnrealBuildTool so the headless <c>-game</c> launch has module
    /// binaries for the project + its C++ plug-ins (OrbitConnector.UE5 /
    /// glTFRuntime ship Source only). Equivalent to what opening the
    /// project in the editor does on first launch. Returns <c>true</c> when
    /// a build ran, <c>false</c> when there was nothing to compile (a
    /// Blueprint-only project with no C++ source or code plug-in). Throws
    /// <see cref="TemplatePullException"/> when the engine root is invalid or
    /// the build exits non-zero (with the build-log tail in the message).
    /// </summary>
    static async Task<bool> CompileProjectAsync(
        string projectDir, string uprojectPath, string projectName,
        string? engineRoot, IProgress<string>? progress, ILogger log, CancellationToken ct)
    {
        // Nothing to compile unless the project itself has C++ source OR a
        // bundled plug-in ships Source (the merged connector does). A purely
        // Blueprint project with no code plug-in needs no binaries.
        if (!ProjectNeedsCompile(projectDir))
        {
            log.LogInformation(
                "template pull: {Name} has no C++ source or code plug-in — skipping compile", projectName);
            progress?.Report("no C++ to compile — skipping build");
            return false;
        }

        if (string.IsNullOrWhiteSpace(engineRoot))
            throw new TemplatePullException(
                "Cannot compile the pulled project: the agent's Unreal Engine root is not configured. " +
                "Set UnrealEngineRoot (e.g. C:\\Program Files\\Epic Games\\UE_5.7) before pulling.");

        var buildBat = Path.Combine(
            engineRoot.Trim(), "Engine", "Build", "BatchFiles", "Build.bat");
        if (!File.Exists(buildBat))
            throw new TemplatePullException(
                $"Cannot compile the pulled project: UnrealBuildTool launcher not found at '{buildBat}'. " +
                $"Check the agent's UnrealEngineRoot ('{engineRoot}') points at a valid Unreal Engine install.");

        var target = ResolveEditorTargetName(projectDir, projectName);

        // Best-effort pre-flight: a Win64 compile needs an MSVC C++ toolchain
        // (VS 2022 "Desktop development with C++": MSVC v143 + a Windows SDK).
        // GPU/streaming boxes that only ever RAN packaged builds often lack it,
        // and UBT then fails platform validation with "Win64 is not a valid
        // platform to build". Probe now so we can warn early and enrich the
        // eventual error; null = inconclusive (we don't block on that).
        var hasToolchain = HasMsvcToolchain(log);
        if (hasToolchain == false)
        {
            log.LogWarning(
                "template pull: no MSVC C++ toolchain detected (vswhere reports no VC.Tools.x86.x64) — " +
                "the Win64 compile will almost certainly fail. Install Visual Studio 2022 (or Build Tools) " +
                "with the \"Desktop development with C++\" workload, or untick \"Compile project after pull\".");
            progress?.Report("warning: no C++ build toolchain detected — compile may fail");
        }

        progress?.Report($"compiling {target} (this can take several minutes)…");
        log.LogInformation(
            "template pull: compiling target={Target} project={Uproject} via {BuildBat} (msvcToolchain={Toolchain})",
            target, uprojectPath, buildBat, hasToolchain?.ToString() ?? "unknown");

        // cmd.exe /c "<bat>" <target> Win64 Development -Project="<uproject>" -WaitMutex -FromMsBuild
        //   -WaitMutex   : serialise with any other UBT instance (mirrors the editor's own build)
        //   -FromMsBuild : compact, parseable diagnostic formatting
        var inner =
            $"\"{buildBat}\" {target} Win64 Development -Project=\"{uprojectPath}\" -WaitMutex -FromMsBuild";
        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = $"/c \"{inner}\"",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = projectDir,
        };

        using var process = new System.Diagnostics.Process { StartInfo = psi };
        var tail = new System.Collections.Concurrent.ConcurrentQueue<string>();
        void Capture(string? line, bool err)
        {
            if (line is null) return;
            if (err) log.LogWarning("ubt: {Line}", line);
            else     log.LogInformation("ubt: {Line}", line);
            tail.Enqueue(line);
            while (tail.Count > 60) tail.TryDequeue(out _);
            // UBT prints "[ n/m] Compile ..." — surface progress to the UI.
            var m = System.Text.RegularExpressions.Regex.Match(line, @"\[\s*(\d+)\s*/\s*(\d+)\s*\]");
            if (m.Success)
                progress?.Report($"compiling {target}… [{m.Groups[1].Value}/{m.Groups[2].Value}]");
        }
        process.OutputDataReceived += (_, e) => Capture(e.Data, err: false);
        process.ErrorDataReceived  += (_, e) => Capture(e.Data, err: true);

        var startedAt = DateTime.UtcNow;
        if (!process.Start())
            throw new TemplatePullException($"Failed to start UnrealBuildTool via '{buildBat}'.");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        // First compiles of a UE project + plug-ins are slow; allow a generous budget.
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromMinutes(45));
        try
        {
            await process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { /* nop */ }
            throw new TemplatePullException(
                $"Compiling {target} timed out after 45 minutes. Check the agent log (channel 'ubt') for the stalled step.");
        }

        var elapsed = DateTime.UtcNow - startedAt;
        if (process.ExitCode != 0)
        {
            var logTail = string.Join("\n", tail);
            var ubtLogTail = ReadUbtLogTail();

            // "Win64 is not a valid platform to build" at the makefile stage is
            // UBT's platform validation failing — i.e. no usable C++ toolchain
            // for Win64. Surface a targeted, actionable hint instead of a bare
            // exit code so this is self-diagnosing.
            var platformInvalid =
                tail.Any(l => l.Contains("is not a valid platform to build", StringComparison.OrdinalIgnoreCase)) ||
                (ubtLogTail?.Contains("is not a valid platform to build", StringComparison.OrdinalIgnoreCase) ?? false);

            var hint = "";
            if (platformInvalid)
            {
                hint =
                    "\n\nDiagnosis: UBT rejected the Win64 platform at the makefile stage — almost always a MISSING " +
                    "C++ BUILD TOOLCHAIN on this workstation. Fix it by installing Visual Studio 2022 (Community or " +
                    "Build Tools) with the \"Desktop development with C++\" workload (MSVC v143 + a Windows 10/11 SDK), " +
                    "then restart the agent and pull again. " +
                    (hasToolchain == false ? "(vswhere confirms no MSVC C++ tools are installed on this box.) " : "") +
                    "IMMEDIATE WORKAROUND: untick \"Compile project after pull\" in the agent web UI " +
                    "(VisualiserCompileProject=false) to pull WITHOUT compiling — use only if the project is compiled " +
                    "elsewhere or this box runs a pre-built engine/project.";
            }
            var ubtLogSection = string.IsNullOrWhiteSpace(ubtLogTail)
                ? ""
                : $"\n\nUnrealBuildTool log tail ({UbtLogPath()}):\n{ubtLogTail}";

            log.LogError(
                "template pull: compile FAILED target={Target} exit={Exit} elapsedMin={Min:F1} platformInvalid={PlatformInvalid}",
                target, process.ExitCode, elapsed.TotalMinutes, platformInvalid);
            throw new TemplatePullException(
                $"Compiling {target} failed (UnrealBuildTool exit {process.ExitCode}).{hint}\n\nLast build output:\n{logTail}{ubtLogSection}");
        }

        log.LogInformation(
            "template pull: compiled {Target} in {Min:F1} min", target, elapsed.TotalMinutes);
        progress?.Report($"compiled {target} ({elapsed.TotalMinutes:F1} min)");
        return true;
    }

    /// <summary>Absolute path of UnrealBuildTool's own diagnostic log.</summary>
    static string UbtLogPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "UnrealBuildTool", "Log.txt");

    /// <summary>
    /// Read the tail of UBT's own <c>Log.txt</c> (the path UBT prints on every
    /// run, e.g. <c>%LOCALAPPDATA%\UnrealBuildTool\Log.txt</c>). It carries the
    /// detailed platform/SDK validation lines that the redirected stdout
    /// summary omits, so surfacing it makes a compile failure self-diagnosing.
    /// Opened shared (UBT may still hold the handle). Returns null when the log
    /// is absent or unreadable.
    /// </summary>
    static string? ReadUbtLogTail(int maxLines = 40)
    {
        try
        {
            var path = UbtLogPath();
            if (!File.Exists(path)) return null;
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var sr = new StreamReader(fs);
            var lines = sr.ReadToEnd().Replace("\r\n", "\n").Split('\n');
            return string.Join("\n", lines.Skip(Math.Max(0, lines.Length - maxLines))).TrimEnd();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Best-effort probe for an installed MSVC C++ toolchain (the thing UBT
    /// needs to build Win64). Uses Visual Studio's <c>vswhere.exe</c> at its
    /// fixed installer path, requiring the
    /// <c>Microsoft.VisualStudio.Component.VC.Tools.x86.x64</c> component
    /// (MSVC v143). Returns <c>true</c>/<c>false</c> when it can tell, or
    /// <c>null</c> when inconclusive (vswhere missing, timed out, threw) — the
    /// caller must NOT hard-block on null to avoid false positives.
    /// </summary>
    static bool? HasMsvcToolchain(ILogger log)
    {
        try
        {
            var vswhere = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                "Microsoft Visual Studio", "Installer", "vswhere.exe");
            if (!File.Exists(vswhere)) return null; // can't tell without vswhere

            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = vswhere,
                Arguments = "-latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 " +
                            "-property installationPath",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using var p = System.Diagnostics.Process.Start(psi);
            if (p is null) return null;
            var stdout = p.StandardOutput.ReadToEnd();
            if (!p.WaitForExit(10_000)) { try { p.Kill(); } catch { /* nop */ } return null; }
            return !string.IsNullOrWhiteSpace(stdout);
        }
        catch (Exception ex)
        {
            log.LogDebug(ex, "template pull: MSVC toolchain probe (vswhere) failed");
            return null;
        }
    }

    /// <summary>
    /// True when the installed project tree has C++ that needs building:
    /// either the project carries its own <c>Source\*.Build.cs</c>/<c>*.Target.cs</c>
    /// module, or a bundled plug-in under <c>Plugins\</c> ships a
    /// <c>Source\*.Build.cs</c> (the merged OrbitConnector.UE5 does).
    /// </summary>
    static bool ProjectNeedsCompile(string projectDir)
    {
        var projectSource = Path.Combine(projectDir, "Source");
        if (Directory.Exists(projectSource) &&
            Directory.EnumerateFiles(projectSource, "*.Build.cs", SearchOption.AllDirectories).Any())
            return true;

        var pluginsDir = Path.Combine(projectDir, "Plugins");
        if (Directory.Exists(pluginsDir) &&
            Directory.EnumerateFiles(pluginsDir, "*.Build.cs", SearchOption.AllDirectories).Any())
            return true;

        return false;
    }

    /// <summary>
    /// Resolve the UBT Editor target name. Prefers an explicit
    /// <c>Source\*Editor.Target.cs</c> (honours a custom target name); else
    /// falls back to the conventional <c>&lt;ProjectName&gt;Editor</c> — which
    /// UBT also synthesises for a content-only project that enables a code
    /// plug-in (exactly our scaffold + connector case).
    /// </summary>
    static string ResolveEditorTargetName(string projectDir, string projectName)
    {
        var sourceDir = Path.Combine(projectDir, "Source");
        if (Directory.Exists(sourceDir))
        {
            var editorTarget = Directory
                .EnumerateFiles(sourceDir, "*.Target.cs", SearchOption.TopDirectoryOnly)
                .Select(Path.GetFileName)
                .FirstOrDefault(f => f!.EndsWith("Editor.Target.cs", StringComparison.OrdinalIgnoreCase));
            if (editorTarget is not null)
                return editorTarget[..^".Target.cs".Length];
        }
        return projectName + "Editor";
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
    ///
    /// <para>
    /// Hardened against the two failure modes seen in the field:
    /// (1) <b>read-only files</b> — git-sourced zipballs and UE
    /// <c>Intermediate\</c>/<c>Saved\</c> trees carry read-only attributes,
    /// which make a plain <see cref="Directory.Delete(string,bool)"/> throw
    /// <see cref="UnauthorizedAccessException"/>; (2) <b>locked handles</b> —
    /// a running Unreal Editor / orchestrator / Explorer / antivirus holds the
    /// old project open, which makes <see cref="Directory.Move(string,string)"/>
    /// throw "Access to the path … is denied". Stale <c>.pull-*</c> staging and
    /// <c>.old-*</c> backup dirs from a prior aborted run (themselves often
    /// read-only/locked) are swept first, all destructive ops strip read-only +
    /// retry with backoff, and a genuinely-locked target throws an actionable
    /// <see cref="TemplatePullException"/> rather than a raw OS error.
    /// </para>
    /// </summary>
    static void InstallProject(string projectRoot, string dest, ILogger log)
    {
        var parent = Path.GetDirectoryName(dest)!;
        Directory.CreateDirectory(parent);

        // Sweep stale staging/backup dirs from a previous aborted pull — these
        // are themselves frequently read-only (git objects) or locked, and a
        // left-over one is a common cause of the next pull's access-denied.
        SweepStaleArtifacts(parent, Path.GetFileName(dest), log);

        var staging = Path.Combine(parent, "." + Path.GetFileName(dest) + ".pull-" + Guid.NewGuid().ToString("N")[..8]);

        // Stage a fresh copy first (works across volumes; the extract temp
        // lives under %TEMP% which is often a different drive to C:\PRISM).
        CopyDirectory(projectRoot, staging);

        // Swap: move the old project aside, move the staged copy into place.
        var backup = dest + ".old-" + Guid.NewGuid().ToString("N")[..8];
        try
        {
            if (Directory.Exists(dest)) RobustMove(dest, backup, log);
            RobustMove(staging, dest, log);
        }
        catch (Exception swapEx)
        {
            // Roll back: restore the old project if the move failed midway.
            try { if (!Directory.Exists(dest) && Directory.Exists(backup)) RobustMove(backup, dest, log); }
            catch (Exception ex) { log.LogWarning(ex, "template pull: rollback of {Dest} failed", dest); }
            try { ForceDelete(staging, log); } catch { /* nop */ }

            // Surface a locked-target failure as an actionable message — this
            // is the "Unreal Editor is still open" case the operator hits.
            if (swapEx is UnauthorizedAccessException or IOException)
            {
                throw new TemplatePullException(
                    $"Could not replace the template project at '{dest}' — the folder (or a file inside it) " +
                    "is read-only or locked by another process. Close the Unreal Editor and any Explorer / " +
                    "terminal window using that folder, then pull again. (On the agent web UI, confirming the " +
                    "\"Unreal is running\" prompt force-closes the editor automatically before pulling.)",
                    swapEx);
            }
            throw;
        }

        try { ForceDelete(backup, log); }
        catch (Exception ex) { log.LogDebug(ex, "template pull: could not delete backup {Backup}", backup); }
    }

    /// <summary>
    /// Best-effort removal of <c>.&lt;name&gt;.pull-*</c> staging dirs and
    /// <c>&lt;name&gt;.old-*</c> backup dirs left under <paramref name="parent"/>
    /// by an earlier aborted pull. Each is force-deleted (read-only stripped,
    /// retried); a failure is logged and swallowed so it never blocks the pull.
    /// </summary>
    static void SweepStaleArtifacts(string parent, string name, ILogger log)
    {
        try
        {
            if (!Directory.Exists(parent)) return;
            var stagingPrefix = "." + name + ".pull-";
            var backupPrefix = name + ".old-";
            foreach (var dir in Directory.EnumerateDirectories(parent))
            {
                var leaf = Path.GetFileName(dir);
                if (leaf.StartsWith(stagingPrefix, StringComparison.OrdinalIgnoreCase) ||
                    leaf.StartsWith(backupPrefix, StringComparison.OrdinalIgnoreCase))
                {
                    try { ForceDelete(dir, log); log.LogInformation("template pull: swept stale artifact {Dir}", dir); }
                    catch (Exception ex) { log.LogWarning(ex, "template pull: could not sweep stale artifact {Dir}", dir); }
                }
            }
        }
        catch (Exception ex)
        {
            log.LogDebug(ex, "template pull: stale-artifact sweep of {Parent} failed", parent);
        }
    }

    /// <summary>
    /// <see cref="Directory.Move(string,string)"/> with bounded retry +
    /// backoff. A directory rename fails transiently when a file inside the
    /// source is momentarily open (UE/Explorer/antivirus); read-only
    /// attributes are cleared on the source tree first so the rename isn't
    /// rejected for that reason. Throws the last OS error when all attempts
    /// are exhausted so the caller can map it to an actionable message.
    /// </summary>
    static void RobustMove(string src, string dst, ILogger log)
    {
        ClearReadOnly(src, log);
        const int attempts = 6;
        for (var i = 1; ; i++)
        {
            try { Directory.Move(src, dst); return; }
            catch (Exception ex) when ((ex is UnauthorizedAccessException or IOException) && i < attempts)
            {
                var delayMs = 150 * i;
                log.LogDebug(ex, "template pull: move {Src} -> {Dst} attempt {N}/{Max} failed; retrying in {Ms}ms",
                    src, dst, i, attempts, delayMs);
                Thread.Sleep(delayMs);
            }
        }
    }

    /// <summary>
    /// Recursively delete <paramref name="dir"/> robustly: clear read-only
    /// attributes on every file/subdir first (so <c>.git</c> objects / packed
    /// files don't trip <see cref="UnauthorizedAccessException"/>), then delete
    /// with bounded retry + backoff for transient locks. A no-op when the path
    /// does not exist. Throws the last error when exhausted.
    /// </summary>
    internal static void ForceDelete(string dir, ILogger log)
    {
        if (!Directory.Exists(dir)) return;
        const int attempts = 6;
        for (var i = 1; ; i++)
        {
            try
            {
                ClearReadOnly(dir, log);
                Directory.Delete(dir, recursive: true);
                return;
            }
            catch (DirectoryNotFoundException) { return; }
            catch (Exception ex) when ((ex is UnauthorizedAccessException or IOException) && i < attempts)
            {
                var delayMs = 150 * i;
                log.LogDebug(ex, "template pull: delete {Dir} attempt {N}/{Max} failed; retrying in {Ms}ms",
                    dir, i, attempts, delayMs);
                Thread.Sleep(delayMs);
            }
        }
    }

    /// <summary>
    /// Strip <see cref="FileAttributes.ReadOnly"/> from <paramref name="dir"/>
    /// and every file/subdirectory beneath it. Best-effort per entry — a
    /// failure on one file is logged at debug and skipped so the caller's
    /// delete/move still proceeds for the rest.
    /// </summary>
    internal static void ClearReadOnly(string dir, ILogger log)
    {
        try
        {
            var di = new DirectoryInfo(dir);
            if (!di.Exists) return;
            if ((di.Attributes & FileAttributes.ReadOnly) != 0)
                di.Attributes &= ~FileAttributes.ReadOnly;
            foreach (var info in di.EnumerateFileSystemInfos("*", SearchOption.AllDirectories))
            {
                try
                {
                    if ((info.Attributes & FileAttributes.ReadOnly) != 0)
                        info.Attributes &= ~FileAttributes.ReadOnly;
                }
                catch (Exception ex) { log.LogDebug(ex, "template pull: clear read-only failed for {Path}", info.FullName); }
            }
        }
        catch (Exception ex) { log.LogDebug(ex, "template pull: clear read-only sweep failed for {Dir}", dir); }
    }

    internal static void CopyDirectory(string sourceDir, string destDir)
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
    public TemplatePullException(string message, bool isRateLimit = false) : base(message)
    {
        IsRateLimit = isRateLimit;
    }

    public TemplatePullException(string message, Exception inner) : base(message, inner) { }

    /// <summary>True when GitHub returned a rate-limit response (403/429, remaining 0).</summary>
    public bool IsRateLimit { get; }
}
