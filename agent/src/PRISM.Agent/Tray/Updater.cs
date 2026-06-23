using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace PRISM.Agent.Tray;

/// <summary>
/// Checks for new agent releases on GitHub and performs an in-place update
/// by launching a foreground PowerShell script that replaces the binary
/// after the current process exits.
/// </summary>
public static class Updater
{
    /// <summary>
    /// Canonical agent release repo (same target as agent-msi publishes to).
    /// </summary>
    const string ReleasesRepo = "REBUS-Industries/prism-agent";

    static readonly Version _currentVersion =
        typeof(Updater).Assembly.GetName().Version ?? new Version(0, 1, 0);

    /// <summary>
    /// Process-wide gate that prevents two updates from running at the
    /// same time. v0.1.36: a remote WS-triggered update and a local
    /// tray-triggered "Check for updates" click could both call into
    /// <see cref="DownloadAndInstallAsync"/> concurrently, racing on the
    /// same on-disk zip path and the same install directory; the second
    /// caller now fails fast with <see cref="InvalidOperationException"/>
    /// instead of silently corrupting the first attempt.
    /// </summary>
    static readonly SemaphoreSlim _updateGate = new SemaphoreSlim(1, 1);

    /// <summary>
    /// True when <see cref="DownloadAndInstallAsync"/> is currently
    /// inside its critical section. UI and WS dispatchers can read this
    /// to short-circuit before kicking off a redundant download.
    /// </summary>
    public static bool IsUpdateInProgress => _updateGate.CurrentCount == 0;

    // ------------------------------------------------------------------

    /// <summary>
    /// Result of <see cref="CheckForUpdateAsync"/>.  <see cref="SizeBytes"/>
    /// and <see cref="Notes"/> come straight from the GitHub release JSON
    /// when present (size on the zip asset; body on the release itself)
    /// so the tray "Update available" dialog can show download size and a
    /// preview of release notes without making a second API call.
    /// </summary>
    public sealed record UpdateInfo(
        string TagName,
        string DownloadUrl,
        Version NewVersion,
        long? SizeBytes = null,
        string? Notes = null);

    // ------------------------------------------------------------------

    /// <summary>
    /// Returns <c>null</c> if already up to date, otherwise the available update.
    /// </summary>
    public static async Task<UpdateInfo?> CheckForUpdateAsync()
    {
        using var http = new HttpClient();
        http.DefaultRequestHeaders.UserAgent.ParseAdd(
            $"PRISM.Agent/{_currentVersion} (Windows)");

        UpdateInfo? best;
        try
        {
            best = await FetchLatestFromRepoAsync(http, ReleasesRepo);
        }
        catch
        {
            return null;
        }

        if (best is null || best.NewVersion <= _currentVersion)
            return null;

        return best;
    }

    static async Task<UpdateInfo?> FetchLatestFromRepoAsync(HttpClient http, string repo)
    {
        string json;
        try
        {
            json = await http.GetStringAsync(
                $"https://api.github.com/repos/{repo}/releases/latest");
        }
        catch
        {
            return null;
        }

        using var doc = JsonDocument.Parse(json);
        var root    = doc.RootElement;

        var tagName = root.TryGetProperty("tag_name", out var tn) ? tn.GetString() : null;
        if (string.IsNullOrEmpty(tagName)) return null;

        string? notes = root.TryGetProperty("body", out var nb) ? nb.GetString() : null;

        string? downloadUrl = null;
        long?   sizeBytes   = null;
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
                    if (a.TryGetProperty("size", out var sz) &&
                        sz.ValueKind == JsonValueKind.Number)
                    {
                        sizeBytes = sz.GetInt64();
                    }
                    break;
                }
            }
            if (downloadUrl is null)
            {
                downloadUrl = assets[0].TryGetProperty("browser_download_url", out var bu0)
                    ? bu0.GetString()
                    : null;
                if (assets[0].TryGetProperty("size", out var sz0) &&
                    sz0.ValueKind == JsonValueKind.Number)
                {
                    sizeBytes = sz0.GetInt64();
                }
            }
        }

        if (!Version.TryParse(tagName.TrimStart('v'), out var newVersion))
            return null;

        if (string.IsNullOrEmpty(downloadUrl))
            return null;

        return new UpdateInfo(tagName, downloadUrl, newVersion, sizeBytes, notes);
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
    /// Path the in-process <see cref="DownloadAndInstallAsync"/> writes
    /// the target version to BEFORE calling <see cref="Application.Exit"/>.
    /// The relaunched agent reads it to show a "Updated to vX.Y.Z" tray
    /// balloon, then deletes it so the balloon only fires once.
    /// </summary>
    static string NewVersionMarkerPath =>
        Path.Combine(Path.GetTempPath(), "PRISM.Agent.Update.NewVersion");

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
    /// One-shot read of the "we just updated to vX.Y.Z" marker file
    /// stashed by <see cref="DownloadAndInstallAsync"/> before the
    /// previous agent exited.  Returns the recorded tag when the marker
    /// file is present, younger than 10 minutes, and the recorded
    /// version matches the now-running assembly version.  The marker is
    /// deleted on return so the post-update tray balloon only fires
    /// once per actual upgrade.
    /// </summary>
    public static string? ConsumeLastUpdateSuccess()
    {
        try
        {
            if (!File.Exists(NewVersionMarkerPath)) return null;
            var fi = new FileInfo(NewVersionMarkerPath);
            if (fi.LastWriteTime < DateTime.Now.AddMinutes(-10))
            {
                // Stale marker from a prior, abandoned run.  Wipe it.
                try { File.Delete(NewVersionMarkerPath); } catch { /* nop */ }
                return null;
            }

            var recorded = File.ReadAllText(NewVersionMarkerPath).Trim();

            // The marker may be a tag ("v0.1.34") or a bare version ("0.1.34").
            // Compare on the trimmed numeric form.
            var recordedVersion = recorded.TrimStart('v', 'V');
            var currentVersion  = _currentVersion.ToString();

            // Match exactly OR by leading prefix (assembly version is
            // "0.1.34.0" but the tag is "v0.1.34").
            bool versionsMatch =
                currentVersion.StartsWith(recordedVersion, StringComparison.Ordinal) ||
                recordedVersion.StartsWith(currentVersion, StringComparison.Ordinal);

            // One-shot: delete regardless of match so a stale marker can't
            // re-fire on every relaunch.
            try { File.Delete(NewVersionMarkerPath); } catch { /* nop */ }

            return versionsMatch ? recorded : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Downloads the update zip, then launches a foreground PowerShell
    /// script that waits for this process to exit, quiesces the
    /// <c>PRISM.Agent</c> scheduled task, extracts the zip to a staging
    /// directory, swaps it into the install directory, and relaunches the
    /// agent. Calls <see cref="Application.Exit"/> after scheduling the script.
    /// </summary>
    /// <remarks>
    /// v0.1.34: the PowerShell helper window is now intentionally VISIBLE
    /// (<c>CreateNoWindow=false</c>, <c>WindowStyle=Normal</c>) and mirrors
    /// the same step lines to <c>Write-Host</c> that go to the diagnostic
    /// log file.  The user-visible terminal window stays open if a FATAL
    /// error occurs (Read-Host pause) so the operator can copy the message
    /// before retrying.  On the happy path the window closes itself when
    /// the new agent launches.  This replaces the v0.1.32 silent flow
    /// (<c>CreateNoWindow=true</c>) which left the user staring at nothing
    /// after the old agent exited.
    /// </remarks>
    public static async Task DownloadAndInstallAsync(UpdateInfo info, IProgress<int> progress)
    {
        if (string.IsNullOrEmpty(info.DownloadUrl))
            throw new InvalidOperationException("No download URL in the release.");

        // v0.1.36: concurrent-update guard. WaitAsync(0) fails fast instead
        // of queueing, so an admin clicking the WS "Update" button while a
        // local tray "Check for updates" is mid-download (or vice versa)
        // sees "already in progress" immediately rather than two parallel
        // PowerShell helpers racing on the same temp zip + install dir.
        // On the happy path Application.Exit() is scheduled at the end of
        // the critical section and the process tears down shortly after
        // the finally block runs; Release() in finally is therefore safe
        // (the window between release and process death is short and the
        // WS pump is also being shut down by Application.Exit).
        if (!await _updateGate.WaitAsync(0))
        {
            throw new InvalidOperationException(
                "Another update is already in progress on this agent.");
        }

        try
        {
            await DownloadAndInstallCoreAsync(info, progress);
        }
        finally
        {
            _updateGate.Release();
        }
    }

    static async Task DownloadAndInstallCoreAsync(UpdateInfo info, IProgress<int> progress)
    {
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

        // v0.1.36: defensive cleanup of any stale zip left behind by a
        // previous attempt (e.g. an interrupted download, or the
        // crash-on-ExtractToDirectory loop that bit v0.1.34/v0.1.35).
        // An orphaned file with a stale antivirus handle on it would
        // otherwise produce a confusing "file is being used by another
        // process" error on the FileStream open below.
        if (File.Exists(tempZip))
        {
            try { File.Delete(tempZip); }
            catch (IOException) { /* will surface on the open below */ }
        }

        // --- Download ---
        using var http = new HttpClient();
        http.DefaultRequestHeaders.UserAgent.ParseAdd(
            $"PRISM.Agent/{_currentVersion} (Windows)");

        // Tight scope around the network + filesystem handles so they are
        // disposed BEFORE we hand control to the PowerShell helper. The
        // PS helper waits for our PID to exit before touching the zip, so
        // technically the implicit method-exit dispose order is enough,
        // but being explicit costs nothing and removes one race-condition
        // surface from the FATAL post-mortem flow.
        {
            using var resp = await http.GetAsync(
                info.DownloadUrl, HttpCompletionOption.ResponseHeadersRead);
            resp.EnsureSuccessStatusCode();

            var totalBytes = resp.Content.Headers.ContentLength ?? info.SizeBytes ?? 0;
            await using var src = await resp.Content.ReadAsStreamAsync();
            // FileShare.Read so antivirus / Defender can scan the partial
            // zip in-flight without us hitting a sharing-violation write.
            await using var dst = new FileStream(
                tempZip,
                FileMode.Create,
                FileAccess.Write,
                FileShare.Read);
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
            await dst.FlushAsync();
        }
        progress.Report(100);

        // --- Schedule the replacement via PowerShell ---
        var installDir = AppContext.BaseDirectory.TrimEnd('\\', '/');
        var pid        = Environment.ProcessId;
        var exePath    = Path.Combine(installDir, "PRISM.Agent.exe");
        var logPath    = UpdateLogPath;
        var tag        = info.TagName;

        // The new payload is unzipped HERE first, never straight over the live
        // install dir. Extraction into a fresh dir can never trip the loaded-
        // image lock that makes an in-place overwrite of a WinForms DLL such as
        // Accessibility.dll fail with "Access to the path ... is denied". This
        // sits under %LOCALAPPDATA%\PRISM.Agent\, which docs/ANTIVIRUS_EXCLUSIONS.md
        // already lists as an exclusion path, so Defender will not hold freshly
        // written DLLs mid-scan during the subsequent robocopy swap.
        var stagingDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "PRISM.Agent", "update-staging");

        // Wipe any stale log from a previous attempt so the diagnostic-on-
        // next-startup hook only sees this run.
        try { if (File.Exists(logPath)) File.Delete(logPath); } catch { /* nop */ }

        // Stash the target version so the relaunched agent can show a
        // "Updated to vX.Y.Z" tray balloon without text-matching the log.
        try { File.WriteAllText(NewVersionMarkerPath, tag); } catch { /* nop */ }

        // The helper performs a STAGED swap rather than an in-place
        // Expand-Archive over the running install dir. Root cause of the
        // "Access to the path 'C:\Program Files\PRISM.Agent\Accessibility.dll'
        // is denied" loop seen on RB-DA2-PC01 (which already runs the
        // kill-holders-by-name + retry code from v0.3.15): the old flow left
        // the `PRISM.Agent` scheduled task ENABLED, so its AtLogOn/AtStartup
        // triggers + RestartCount=3 relaunched the agent mid-extract, re-mapping
        // the WinForms images (Accessibility.dll et al.) as image sections —
        // and an open-for-write over a mapped image returns ERROR_ACCESS_DENIED
        // regardless of ACLs. The new flow:
        //   1. Disables the scheduled task (best-effort) so the OS cannot
        //      relaunch the agent during the swap, then ends any running task.
        //   2. Stops every lingering holder and waits for handles to drop.
        //   3. Extracts the zip to a FRESH staging dir (can never hit a lock).
        //   4. Verifies the staged PRISM.Agent.exe exists, then robocopies
        //      staging -> install, re-killing any relaunched holder each pass
        //      (robocopy also retries per-file for AV transients).
        //   5. Re-enables + starts the task (falling back to launching the exe).
        // Expand-Archive (not [IO.Compression.ZipFile]::ExtractToDirectory) is
        // still used: the 3-arg overwrite overload only exists on .NET Core, so
        // Windows PowerShell 5.1 would coerce $true -> Encoding and crash;
        // Expand-Archive has been overwrite-aware since PS 5.0.
        var ps = $@"
$ErrorActionPreference = 'Stop'
$log = '{Esc(logPath)}'
$Host.UI.RawUI.WindowTitle = 'PRISM Agent — Updating to {Esc(tag)}'
function W($m) {{
    $line = ""[$([DateTime]::Now.ToString('HH:mm:ss'))] "" + $m
    Add-Content -Path $log -Value $line
    Write-Host $line
}}

W 'PRISM Agent updater — keep this window open until it closes itself'
W 'target version: {Esc(tag)}'

$fatal           = $false
$taskName        = 'PRISM.Agent'
$taskWasDisabled = $false
$holderNames = @('PRISM.Agent','prism-visualiser','UnrealEditor','UnrealEditor-Cmd','UnrealEditor-Win64-DebugGame','CrashReportClient')

function Stop-Holders {{
    foreach ($n in $holderNames) {{
        Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {{
            try {{ $_.CloseMainWindow() | Out-Null }} catch {{ }}
            try {{ Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }} catch {{ }}
        }}
    }}
}}

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

    $zip        = '{Esc(tempZip)}'
    $installDir = '{Esc(installDir)}'
    $staging    = '{Esc(stagingDir)}'
    $exePath    = '{Esc(exePath)}'

    # 1. Quiesce the scheduled task so the OS cannot resurrect the agent while
    #    we swap files. The AtLogOn/AtStartup triggers + RestartCount on the
    #    'PRISM.Agent' task were relaunching the agent mid-extract, re-locking
    #    Accessibility.dll and the other WinForms images. Disable is best-effort:
    #    a non-admin run-as user may lack the right, in which case the per-attempt
    #    kill-loop in step 4 is the fallback.
    W ""disabling scheduled task '$taskName' so it cannot relaunch the agent mid-swap""
    try {{
        & schtasks.exe /Change /TN $taskName /DISABLE 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {{ $taskWasDisabled = $true; W '  scheduled task disabled' }}
        else {{ W ""  WARN: could not disable task (schtasks exit $LASTEXITCODE); relying on kill-loop fallback"" }}
    }} catch {{ W ""  WARN: disabling task threw: $($_.Exception.Message)"" }}
    try {{ & schtasks.exe /End /TN $taskName 2>&1 | Out-Null }} catch {{ }}

    # 2. Stop every lingering holder, then wait for the handles to drop. A child
    #    the visualiser spawned (prism-visualiser.exe / UnrealEditor*) can also
    #    keep modules memory-mapped under the install dir.
    W 'stopping any lingering agent/orchestrator/UE processes that could lock install files'
    Stop-Holders
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {{
        $alive = @($holderNames | ForEach-Object {{ Get-Process -Name $_ -ErrorAction SilentlyContinue }})
        if ($alive.Count -eq 0) {{ break }}
        Start-Sleep -Seconds 1
    }}

    # 3. Extract the new payload into a FRESH staging dir. Because nothing is
    #    loaded from staging, the extract can never hit the loaded-image lock
    #    that made the old in-place Expand-Archive fail on Accessibility.dll.
    if (Test-Path -LiteralPath $staging) {{
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }}
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    W ""extracting $zip -> $staging""
    Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force -ErrorAction Stop
    W 'extraction to staging complete'

    $stagedExe = Join-Path $staging 'PRISM.Agent.exe'
    if (-not (Test-Path -LiteralPath $stagedExe)) {{
        throw ""staged payload is missing PRISM.Agent.exe — the download may be corrupt""
    }}

    # 4. Mirror staging -> install dir. robocopy retries locked files itself
    #    (/R /W); we additionally re-kill any holder the task may have relaunched
    #    before each attempt. /E (not /MIR) overwrites + adds without deleting
    #    unrelated files, matching the old Expand-Archive -Force semantics.
    #    robocopy exit codes < 8 are success.
    W ""installing $staging -> $installDir""
    $maxAttempts = 5
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {{
        Stop-Holders
        Start-Sleep -Milliseconds 800
        & robocopy.exe $staging $installDir /E /R:3 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
        $rc = $LASTEXITCODE
        if ($rc -lt 8) {{
            W ""install complete (attempt $attempt, robocopy code $rc)""
            break
        }}
        if ($attempt -ge $maxAttempts) {{
            throw ""robocopy failed after $maxAttempts attempts (last exit $rc) — an install file stayed locked""
        }}
        $delay = 2 * $attempt
        W ""install attempt $attempt failed (robocopy exit $rc); retrying in $delay s""
        Start-Sleep -Seconds $delay
    }}

    if (-not (Test-Path $exePath)) {{
        $fatal = $true
        W ""FATAL: install did not produce $exePath""
    }} else {{
        try {{
            $newVersion = (Get-Item $exePath).VersionInfo.ProductVersion
            W ""installed version: $newVersion""
        }} catch {{
            W ""WARN: could not read version stamp from $exePath ($_)""
        }}
    }}
}} catch {{
    $fatal = $true
    W ""FATAL: $_""
    if ($_.ScriptStackTrace) {{ W $_.ScriptStackTrace }}
}}

# Always re-enable the scheduled task we disabled, so a failed update can never
# leave the workstation permanently agentless (the AtStartup trigger then
# recovers it on the next boot even if this window is closed before relaunch).
if ($taskWasDisabled) {{
    try {{
        & schtasks.exe /Change /TN $taskName /ENABLE 2>&1 | Out-Null
        W ""re-enabled scheduled task '$taskName'""
    }} catch {{ W ""WARN: could not re-enable task '$taskName': $($_.Exception.Message)"" }}
}}

if ($fatal) {{
    Write-Host ''
    Write-Host '------------------------------------------------------------'
    Write-Host 'Update FAILED. The diagnostic log is at:'
    Write-Host ""  $log""
    Write-Host 'Please copy the lines above before closing this window.'
    Write-Host '------------------------------------------------------------'
    try {{ [void](Read-Host 'Press Enter to close') }} catch {{ Start-Sleep -Seconds 30 }}
}} else {{
    # Relaunch via the scheduled task (correct principal / RunLevel Highest);
    # fall back to launching the exe directly if the task did not bring it up.
    W 'launching new agent'
    try {{ & schtasks.exe /Run /TN $taskName 2>&1 | Out-Null }} catch {{ }}
    Start-Sleep -Milliseconds 800
    if (-not (Get-Process -Name 'PRISM.Agent' -ErrorAction SilentlyContinue)) {{
        W 'scheduled task did not bring the agent up; launching exe directly'
        Start-Process -FilePath $exePath
    }}
    W 'launched'
    # Brief grace so the user sees the 'launched' line before the window closes.
    Start-Sleep -Seconds 2
}}
";
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(ps));
        Process.Start(new ProcessStartInfo
        {
            FileName        = "powershell.exe",
            Arguments       = $"-NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}",
            // UseShellExecute=false lets us control window creation
            // explicitly: with CreateNoWindow=false the child gets a
            // fresh console host attached.  The agent itself is a
            // WinForms tray app with no console, so without an
            // explicit console here the Write-Host lines have nowhere
            // to render.
            UseShellExecute = false,
            // v0.1.34: visible window so the user can see download +
            // extract + relaunch progress instead of "agent closes,
            // nothing happens."  Pre-v0.1.34 used CreateNoWindow=true,
            // which made silent failures indistinguishable from
            // success and was the proximate cause of the v0.1.33 bug
            // report from RB-DA2-PC02.
            CreateNoWindow  = false,
            WindowStyle     = ProcessWindowStyle.Normal,
        });

        Application.Exit();
    }

    static string Esc(string path) => path.Replace("'", "''");
}
