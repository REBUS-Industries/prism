using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace PRISM.Agent.Tray;

/// <summary>
/// Checks for new agent releases on GitHub and performs an in-place update
/// by launching a background PowerShell script that replaces the binary
/// after the current process exits.
/// </summary>
public static class Updater
{
    const string ReleasesUrl =
        "https://api.github.com/repos/REBUS-ORBIT/prism-agent/releases/latest";

    static readonly Version _currentVersion =
        typeof(Updater).Assembly.GetName().Version ?? new Version(0, 1, 0);

    // ------------------------------------------------------------------

    public sealed record UpdateInfo(string TagName, string DownloadUrl, Version NewVersion);

    // ------------------------------------------------------------------

    /// <summary>
    /// Returns <c>null</c> if already up to date, otherwise the available update.
    /// </summary>
    public static async Task<UpdateInfo?> CheckForUpdateAsync()
    {
        using var http = new HttpClient();
        http.DefaultRequestHeaders.UserAgent.ParseAdd(
            $"PRISM.Agent/{_currentVersion} (Windows)");

        string json;
        try
        {
            json = await http.GetStringAsync(ReleasesUrl);
        }
        catch
        {
            // No network / private repo — treat as up-to-date.
            return null;
        }

        using var doc = JsonDocument.Parse(json);
        var root    = doc.RootElement;

        var tagName = root.TryGetProperty("tag_name", out var tn) ? tn.GetString() : null;
        if (string.IsNullOrEmpty(tagName)) return null;

        string? downloadUrl = null;
        if (root.TryGetProperty("assets", out var assets) &&
            assets.ValueKind == JsonValueKind.Array &&
            assets.GetArrayLength() > 0)
        {
            // Prefer the multi-file publish .zip — that is what the
            // PowerShell update script knows how to extract over the install
            // dir.  Fall back to the first asset only if no .zip is present
            // (defensive; the agent.yml workflow always uploads a zip first).
            // The wizard installer (.exe) is intentionally NOT auto-applied
            // because it is interactive (UAC prompt + finish-page checkboxes).
            for (int i = 0; i < assets.GetArrayLength(); i++)
            {
                var a = assets[i];
                var name = a.TryGetProperty("name", out var n) ? n.GetString() : null;
                if (name != null &&
                    name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) &&
                    a.TryGetProperty("browser_download_url", out var bu))
                {
                    downloadUrl = bu.GetString();
                    break;
                }
            }
            if (downloadUrl is null)
            {
                downloadUrl = assets[0].TryGetProperty("browser_download_url", out var bu0)
                    ? bu0.GetString()
                    : null;
            }
        }

        if (!Version.TryParse(tagName.TrimStart('v'), out var newVersion))
            return null;

        return newVersion > _currentVersion
            ? new UpdateInfo(tagName, downloadUrl ?? "", newVersion)
            : null;
    }

    // ------------------------------------------------------------------

    /// <summary>
    /// Path the update PowerShell script writes its diagnostic log to.
    /// Survives across the agent restart so the next launch can surface
    /// the result of the last update attempt.
    /// </summary>
    static string UpdateLogPath =>
        Path.Combine(Path.GetTempPath(), "PRISM.Agent.Update.log");

    /// <summary>
    /// True when the agent's install directory is writable by the current
    /// user.  When false, the in-app updater cannot extract the new zip
    /// in place and will silently fail; we surface that to the operator
    /// instead of pretending the update succeeded.
    /// </summary>
    public static bool IsInstallDirWritable()
    {
        var probe = Path.Combine(
            AppContext.BaseDirectory,
            ".update-probe-" + Guid.NewGuid().ToString("N"));
        try
        {
            File.WriteAllText(probe, "x");
            File.Delete(probe);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Returns the trailing portion of the most recent update log if it
    /// contains a fatal marker and post-dates this process's start time.
    /// Used by the tray to surface a "last update failed" message when
    /// the agent is relaunched after a botched update.
    /// </summary>
    public static string? GetLastUpdateFailure()
    {
        try
        {
            if (!File.Exists(UpdateLogPath)) return null;
            var fi = new FileInfo(UpdateLogPath);
            // Only care about logs younger than 10 minutes -- anything
            // older was a previous session the operator already saw.
            if (fi.LastWriteTime < DateTime.Now.AddMinutes(-10)) return null;

            var text = File.ReadAllText(UpdateLogPath);
            if (text.Contains("FATAL", StringComparison.Ordinal) ||
                text.Contains("ERROR", StringComparison.Ordinal))
            {
                return text;
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Downloads the update zip, then launches a background PowerShell script
    /// that waits for this process to exit, extracts the zip over the install
    /// directory, and relaunches the agent.
    /// Calls <see cref="Application.Exit"/> after scheduling the script.
    /// </summary>
    public static async Task DownloadAndInstallAsync(UpdateInfo info, IProgress<int> progress)
    {
        if (string.IsNullOrEmpty(info.DownloadUrl))
            throw new InvalidOperationException("No download URL in the release.");

        // Pre-flight: verify we can actually overwrite the install dir.
        // On workstations whose interactive user is not a local admin and
        // whose install was done via the legacy install.ps1 (pre-v0.1.32,
        // no Users:Modify grant), Program Files is read-only and the
        // updater would silently fail.  Fail loudly instead.
        if (!IsInstallDirWritable())
        {
            throw new UnauthorizedAccessException(
                "The agent's install directory is not writable by this Windows " +
                "user, so the in-app updater cannot replace the running binaries. " +
                "Please re-run PRISM.Agent-Setup.exe (run as administrator) once " +
                "to grant write access -- future in-app updates will then work " +
                "without elevation.");
        }

        var tempZip = Path.Combine(Path.GetTempPath(), "PRISM.Agent.Update.zip");

        // --- Download ---
        using var http = new HttpClient();
        http.DefaultRequestHeaders.UserAgent.ParseAdd(
            $"PRISM.Agent/{_currentVersion} (Windows)");

        using var resp = await http.GetAsync(
            info.DownloadUrl, HttpCompletionOption.ResponseHeadersRead);
        resp.EnsureSuccessStatusCode();

        var totalBytes = resp.Content.Headers.ContentLength ?? 0;
        await using var src = await resp.Content.ReadAsStreamAsync();
        await using var dst = File.Create(tempZip);
        var buf        = new byte[65536];
        long downloaded = 0;
        int  read;
        while ((read = await src.ReadAsync(buf)) > 0)
        {
            await dst.WriteAsync(buf.AsMemory(0, read));
            downloaded += read;
            if (totalBytes > 0)
                progress.Report((int)(downloaded * 100 / totalBytes));
        }
        progress.Report(100);

        // --- Schedule the replacement via PowerShell ---
        var installDir = AppContext.BaseDirectory.TrimEnd('\\', '/');
        var pid        = Environment.ProcessId;
        var exePath    = Path.Combine(installDir, "PRISM.Agent.exe");
        var logPath    = UpdateLogPath;

        // Wipe any stale log from a previous attempt so the diagnostic-on-
        // next-startup hook only sees this run.
        try { if (File.Exists(logPath)) File.Delete(logPath); } catch { /* nop */ }

        // Single-quoted strings inside the PS script escape ' as ''.
        var ps = $@"
$ErrorActionPreference = 'Stop'
$log = '{Esc(logPath)}'
function W($m) {{ Add-Content -Path $log -Value (""[$([DateTime]::Now.ToString('HH:mm:ss'))] "" + $m) }}

try {{
    W 'update script started'
    $proc = Get-Process -Id {pid} -ErrorAction SilentlyContinue
    if ($proc) {{
        W 'waiting for agent pid {pid} to exit'
        $null = $proc.WaitForExit(60000)
        W 'agent exited'
    }} else {{
        W 'agent already exited'
    }}
    Start-Sleep -Milliseconds 500
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    W 'extracting {Esc(tempZip)} -> {Esc(installDir)}'
    [IO.Compression.ZipFile]::ExtractToDirectory('{Esc(tempZip)}', '{Esc(installDir)}', $true)
    W 'extraction complete'
    if (Test-Path '{Esc(exePath)}') {{
        W 'launching new agent'
        Start-Process -FilePath '{Esc(exePath)}'
        W 'launched'
    }} else {{
        W ""ERROR: exe not found at '{Esc(exePath)}'""
    }}
}} catch {{
    W ""FATAL: $_""
    if ($_.ScriptStackTrace) {{ W $_.ScriptStackTrace }}
}}
";
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(ps));
        Process.Start(new ProcessStartInfo
        {
            FileName        = "powershell.exe",
            Arguments       = $"-NoProfile -NonInteractive -EncodedCommand {encoded}",
            UseShellExecute = false,
            // CreateNoWindow=true is what actually suppresses the brief
            // CMD/console flash that -WindowStyle Hidden cannot prevent
            // (Hidden takes effect only after the window is created).
            CreateNoWindow  = true,
        });

        Application.Exit();
    }

    static string Esc(string path) => path.Replace("'", "''");
}
