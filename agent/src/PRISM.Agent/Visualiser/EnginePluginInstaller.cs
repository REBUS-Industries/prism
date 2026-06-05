using System.IO.Compression;
using System.Net;
using System.Net.Http;
using Microsoft.Extensions.Logging;

namespace PRISM.Agent.Visualiser;

/// <summary>
/// Installs an Unreal Engine plug-in into the workstation's engine
/// <c>Engine\Plugins\</c> directory from a pasted file URL.
///
/// <para>
/// Flow: validate the URL (http/https only) → stream-download to a temp file
/// → if it's a zip, extract → locate the single <c>Plugins</c> folder inside
/// the archive (at the root or one level down) → copy every entry inside that
/// folder into <c>&lt;UnrealEngineRoot&gt;\Engine\Plugins\</c>, overwriting
/// same-named plug-ins. Reuses <see cref="TemplatePuller"/>'s robust
/// copy/delete helpers (clear read-only, retry on transient locks) so an
/// existing plug-in (whose <c>Binaries\*.dll</c> are read-only / were just
/// released by a force-closed editor) can be replaced cleanly.
/// </para>
///
/// <para>
/// Only the specific entries inside the archive's <c>Plugins</c> folder are
/// replaced/merged — the rest of <c>Engine\Plugins\</c> (the engine's own
/// plug-ins) is never touched. Engine plug-in DLLs are locked while the editor
/// is open, so the caller (control plane) runs the same
/// <see cref="UnrealProcessGuard"/> detect→confirm→force-close guard the
/// template pull uses before copying.
/// </para>
/// </summary>
public static class EnginePluginInstaller
{
    /// <summary>Hard cap on the downloaded file size (4 GiB) to avoid a runaway download.</summary>
    const long MaxDownloadBytes = 4L * 1024 * 1024 * 1024;

    /// <summary>Base temp dir for downloads/extraction; per-run work lives in a GUID subfolder.</summary>
    static string WorkRoot => Path.Combine(Path.GetTempPath(), "PRISM.Agent.EnginePlugin");

    /// <summary>Outcome of a successful install.</summary>
    /// <param name="InstalledPlugins">Names of the plug-in folders/files copied into <c>Engine\Plugins\</c>.</param>
    /// <param name="SourceUrl">The URL that was downloaded.</param>
    /// <param name="EnginePluginsDir">The resolved <c>Engine\Plugins\</c> target directory.</param>
    public sealed record InstallResult(
        IReadOnlyList<string> InstalledPlugins,
        string SourceUrl,
        string EnginePluginsDir);

    /// <summary>
    /// Download + install the engine plug-in archive at <paramref name="url"/>
    /// into <paramref name="engineRoot"/>'s <c>Engine\Plugins\</c>. Throws
    /// <see cref="EnginePluginInstallException"/> for any actionable failure
    /// (bad URL, HTTP error, not a zip, no/ambiguous Plugins folder, missing
    /// engine root, filesystem error).
    /// </summary>
    public static async Task<InstallResult> InstallAsync(
        string url, string? engineRoot, IProgress<string>? progress, ILogger log, CancellationToken ct)
    {
        // 1. Validate URL — http/https only (no file://, no local paths).
        if (string.IsNullOrWhiteSpace(url))
            throw new EnginePluginInstallException("No URL provided.");
        url = url.Trim();
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            throw new EnginePluginInstallException(
                $"Invalid URL '{url}'. Provide an absolute http(s):// link to a plug-in .zip.");

        // 2. Resolve + validate the engine Plugins target directory.
        var enginePluginsDir = ResolveEnginePluginsDir(engineRoot);

        var workDir = Path.Combine(WorkRoot, Guid.NewGuid().ToString("N"));
        SweepStaleWorkDirs(log);
        Directory.CreateDirectory(workDir);
        try
        {
            // 3. Download to a temp file.
            progress?.Report("downloading…");
            var downloadName = SafeFileName(uri) ?? "plugin-download";
            var downloadPath = Path.Combine(workDir, downloadName);
            await DownloadAsync(url, downloadPath, progress, log, ct).ConfigureAwait(false);

            // 4. Must be a zip (by extension or PK magic). "Unzip if necessary":
            //    a non-zip cannot carry a Plugins folder, so report clearly.
            if (!IsZip(downloadPath))
                throw new EnginePluginInstallException(
                    "The downloaded file is not a .zip archive. Provide a .zip that contains a 'Plugins' " +
                    "folder with the plug-in(s) to install inside it.");

            progress?.Report("extracting…");
            var extractDir = Path.Combine(workDir, "extract");
            Directory.CreateDirectory(extractDir);
            try
            {
                ZipFile.ExtractToDirectory(downloadPath, extractDir);
            }
            catch (InvalidDataException ex)
            {
                throw new EnginePluginInstallException(
                    "The downloaded file could not be read as a .zip archive (it may be corrupt or an HTML " +
                    "error page rather than the plug-in zip). Check the URL points directly at the .zip.", ex);
            }

            // 5. Locate THE Plugins folder (root or one level down, case-insensitive).
            var pluginsDir = LocatePluginsFolder(extractDir);

            // 6. Copy each entry inside Plugins\ into Engine\Plugins\ (overwrite).
            progress?.Report($"installing into {enginePluginsDir}…");
            var installed = CopyPluginsInto(pluginsDir, enginePluginsDir, log);
            if (installed.Count == 0)
                throw new EnginePluginInstallException(
                    "The archive's 'Plugins' folder is empty — nothing to install.");

            log.LogInformation(
                "engine plugin install: installed [{Plugins}] from {Url} into {Dir}",
                string.Join(", ", installed), url, enginePluginsDir);
            progress?.Report($"done: installed {string.Join(", ", installed)}");
            return new InstallResult(installed, url, enginePluginsDir);
        }
        finally
        {
            try { TemplatePuller.ForceDelete(workDir, log); }
            catch (Exception ex) { log.LogDebug(ex, "engine plugin install: temp cleanup failed for {Dir}", workDir); }
        }
    }

    /// <summary>
    /// Resolve <c>&lt;engineRoot&gt;\Engine\Plugins</c> and verify it exists.
    /// Throws an actionable <see cref="EnginePluginInstallException"/> when the
    /// engine root is unset or the directory is missing.
    /// </summary>
    public static string ResolveEnginePluginsDir(string? engineRoot)
    {
        if (string.IsNullOrWhiteSpace(engineRoot))
            throw new EnginePluginInstallException(
                "The agent's Unreal Engine root is not configured. Set UnrealEngineRoot " +
                "(e.g. C:\\Program Files\\Epic Games\\UE_5.7) in the agent settings before installing a plug-in.");

        var dir = Path.Combine(engineRoot.Trim(), "Engine", "Plugins");
        if (!Directory.Exists(dir))
            throw new EnginePluginInstallException(
                $"Engine plug-ins directory not found at '{dir}'. Check the agent's UnrealEngineRoot " +
                $"('{engineRoot}') points at a valid Unreal Engine install.");
        return dir;
    }

    static async Task DownloadAsync(
        string url, string destPath, IProgress<string>? progress, ILogger log, CancellationToken ct)
    {
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true })
        {
            Timeout = TimeSpan.FromMinutes(20),
        };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PRISM.Agent (+https://github.com/REBUS-ORBIT/prism)");

        using var resp = await http
            .GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
            throw new EnginePluginInstallException(
                $"Download failed: HTTP {(int)resp.StatusCode} {resp.ReasonPhrase} for {url}.");

        var total = resp.Content.Headers.ContentLength ?? 0;
        if (total > MaxDownloadBytes)
            throw new EnginePluginInstallException(
                $"The file is {total / (1024 * 1024)} MB which exceeds the {MaxDownloadBytes / (1024 * 1024 * 1024)} GB install limit.");

        await using var src = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await using var dst = new FileStream(
            destPath, FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true);

        var buf = new byte[64 * 1024];
        long downloaded = 0;
        int lastPct = -1;
        int read;
        while ((read = await src.ReadAsync(buf, ct).ConfigureAwait(false)) > 0)
        {
            downloaded += read;
            if (downloaded > MaxDownloadBytes)
                throw new EnginePluginInstallException(
                    $"Download exceeded the {MaxDownloadBytes / (1024 * 1024 * 1024)} GB install limit; aborting.");
            await dst.WriteAsync(buf.AsMemory(0, read), ct).ConfigureAwait(false);
            if (total > 0)
            {
                var pct = (int)(downloaded * 100 / total);
                if (pct >= lastPct + 10) { lastPct = pct; progress?.Report($"downloading… {pct}%"); }
            }
        }
        await dst.FlushAsync(ct).ConfigureAwait(false);
        log.LogInformation("engine plugin install: downloaded {Bytes} bytes from {Url}", downloaded, url);
    }

    /// <summary>True when the file starts with the ZIP local-file magic (PK\x03\x04) or ends in .zip.</summary>
    static bool IsZip(string path)
    {
        if (path.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) return true;
        try
        {
            using var fs = File.OpenRead(path);
            Span<byte> head = stackalloc byte[4];
            if (fs.Read(head) < 4) return false;
            // PK\x03\x04 (normal) or PK\x05\x06 (empty archive).
            return head[0] == 0x50 && head[1] == 0x4B &&
                   ((head[2] == 0x03 && head[3] == 0x04) || (head[2] == 0x05 && head[3] == 0x06));
        }
        catch { return false; }
    }

    /// <summary>
    /// Find the single <c>Plugins</c> folder (case-insensitive) at the archive
    /// root or exactly one level down (e.g. <c>repo-main\Plugins</c>). Throws
    /// when none or more than one is found so the operator gets a clear error.
    /// </summary>
    static string LocatePluginsFolder(string extractDir)
    {
        var matches = new List<string>();

        foreach (var top in Directory.EnumerateDirectories(extractDir))
        {
            if (IsPluginsLeaf(top)) matches.Add(top);
            foreach (var sub in Directory.EnumerateDirectories(top))
                if (IsPluginsLeaf(sub)) matches.Add(sub);
        }

        // De-dupe (a path can't appear twice here, but be defensive).
        matches = matches.Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        if (matches.Count == 0)
            throw new EnginePluginInstallException(
                "The archive does not contain a 'Plugins' folder (looked at the archive root and one level " +
                "down). The .zip must contain a 'Plugins' folder with the plug-in(s) to install inside it.");
        if (matches.Count > 1)
            throw new EnginePluginInstallException(
                $"The archive contains multiple 'Plugins' folders ({matches.Count}); cannot decide which to " +
                "install. Provide a .zip with a single 'Plugins' folder.");
        return matches[0];

        static bool IsPluginsLeaf(string dir) =>
            string.Equals(Path.GetFileName(dir), "Plugins", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Copy every immediate entry (file AND folder) inside
    /// <paramref name="pluginsDir"/> into <paramref name="enginePluginsDir"/>,
    /// overwriting same-named entries. Directories are force-deleted first
    /// (clears read-only + retries) then deep-copied; files are copied with
    /// read-only cleared on any existing target. Returns the installed names.
    /// </summary>
    static IReadOnlyList<string> CopyPluginsInto(string pluginsDir, string enginePluginsDir, ILogger log)
    {
        Directory.CreateDirectory(enginePluginsDir);
        var installed = new List<string>();

        foreach (var srcDir in Directory.EnumerateDirectories(pluginsDir))
        {
            var name = Path.GetFileName(srcDir);
            var dest = Path.Combine(enginePluginsDir, name);
            if (Directory.Exists(dest)) TemplatePuller.ForceDelete(dest, log);
            else if (File.Exists(dest)) { ClearReadOnlyFile(dest); File.Delete(dest); }
            TemplatePuller.CopyDirectory(srcDir, dest);
            installed.Add(name);
            log.LogInformation("engine plugin install: installed plugin folder '{Name}'", name);
        }

        foreach (var srcFile in Directory.EnumerateFiles(pluginsDir))
        {
            var name = Path.GetFileName(srcFile);
            var dest = Path.Combine(enginePluginsDir, name);
            if (Directory.Exists(dest)) TemplatePuller.ForceDelete(dest, log);
            else if (File.Exists(dest)) ClearReadOnlyFile(dest);
            File.Copy(srcFile, dest, overwrite: true);
            installed.Add(name);
            log.LogInformation("engine plugin install: installed file '{Name}'", name);
        }

        return installed;
    }

    static void ClearReadOnlyFile(string path)
    {
        try
        {
            var attrs = File.GetAttributes(path);
            if ((attrs & FileAttributes.ReadOnly) != 0)
                File.SetAttributes(path, attrs & ~FileAttributes.ReadOnly);
        }
        catch { /* best-effort */ }
    }

    /// <summary>Best-effort removal of leftover work dirs from prior (possibly crashed) runs.</summary>
    static void SweepStaleWorkDirs(ILogger log)
    {
        try
        {
            if (!Directory.Exists(WorkRoot)) return;
            foreach (var dir in Directory.EnumerateDirectories(WorkRoot))
            {
                try { TemplatePuller.ForceDelete(dir, log); }
                catch (Exception ex) { log.LogDebug(ex, "engine plugin install: stale sweep failed for {Dir}", dir); }
            }
        }
        catch (Exception ex) { log.LogDebug(ex, "engine plugin install: stale sweep of {Root} failed", WorkRoot); }
    }

    static string? SafeFileName(Uri uri)
    {
        try
        {
            var name = Path.GetFileName(uri.AbsolutePath);
            if (string.IsNullOrWhiteSpace(name)) return null;
            foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name;
        }
        catch { return null; }
    }
}

/// <summary>Actionable failure during an engine plug-in install (surfaced to the operator).</summary>
public sealed class EnginePluginInstallException : Exception
{
    public EnginePluginInstallException(string message) : base(message) { }
    public EnginePluginInstallException(string message, Exception inner) : base(message, inner) { }
}
