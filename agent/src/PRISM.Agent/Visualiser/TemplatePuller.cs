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
    public sealed record PullResult(
        string ProjectName,
        string ProjectPath,
        string UprojectPath,
        string Tag,
        string SourceUrl);

    /// <summary>
    /// Pull + install a template. Throws <see cref="TemplatePullException"/>
    /// for any actionable failure (bad repo slug, no release, no archive,
    /// no <c>.uproject</c> in the archive, filesystem error).
    /// </summary>
    /// <param name="repoSlug">GitHub <c>owner/repo</c> slug.</param>
    /// <param name="requestedTag">Caller/admin-pinned tag; takes precedence.</param>
    /// <param name="configuredTag">The agent's configured default tag.</param>
    /// <param name="templateRoot">Root dir to install the project under.</param>
    /// <param name="progress">Optional human-readable progress sink (web UI status line).</param>
    public static async Task<PullResult> PullAsync(
        string repoSlug,
        string? requestedTag,
        string? configuredTag,
        string templateRoot,
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

        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true })
        {
            Timeout = TimeSpan.FromMinutes(10),
        };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PRISM.Agent (+https://github.com/REBUS-ORBIT/prism)");
        http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        var token = Environment.GetEnvironmentVariable("PRISM_GITHUB_TOKEN")
                    ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN");
        if (!string.IsNullOrWhiteSpace(token))
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token.Trim());

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

            // 5. Install: replace <root>\<ProjectName> atomically.
            Directory.CreateDirectory(templateRoot);
            var dest = Path.Combine(templateRoot, projectName);
            progress?.Report($"installing to {dest}…");
            InstallProject(projectRoot, dest, log);

            var installedUproject = Path.Combine(dest, Path.GetFileName(uproject));
            log.LogInformation(
                "template pull: installed {Name} tag={Tag} -> {Dest}", projectName, resolvedTag, dest);
            progress?.Report($"done: {projectName} ({resolvedTag})");

            return new PullResult(projectName, dest, installedUproject, resolvedTag, archiveUrl);
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
