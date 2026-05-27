using Serilog;
using Serilog.Events;

namespace PRISM.Visualiser.Orchestrator.Logging;

/// <summary>
/// Bootstraps the Serilog logger used by every other module. The plan
/// is explicit about two sinks:
///   - console sink to STDERR at Information+ (stdout is reserved for
///     the ready handshake JSON line, so nothing else may write there)
///   - file sink at Verbose to
///     <c>%LOCALAPPDATA%\PRISM.Visualiser\runs\&lt;runId&gt;\logs\orchestrator.log</c>
///
/// Phase B keeps the logger configuration in code (no JSON config file)
/// because the orchestrator only ever has one logging shape.
/// </summary>
public static class StructuredLog
{
    /// <summary>
    /// Build a logger scoped to <paramref name="runId"/>. Caller is
    /// responsible for disposal (typically via <c>await using</c> on a
    /// logger lifetime). Returns the configured logger and the resolved
    /// logs directory so the caller can echo it back in the ready event.
    /// </summary>
    public static (ILogger Logger, string LogsDirectory) CreateRunLogger(string runId)
    {
        if (string.IsNullOrWhiteSpace(runId))
            throw new ArgumentException("runId must be a non-empty string", nameof(runId));

        var logsDir = ResolveLogsDirectory(runId);
        Directory.CreateDirectory(logsDir);
        var logPath = Path.Combine(logsDir, "orchestrator.log");

        var logger = new LoggerConfiguration()
            .MinimumLevel.Verbose()
            .Enrich.WithProperty("runId", runId)
            .Enrich.WithProperty("component", "orchestrator")
            .WriteTo.Console(
                restrictedToMinimumLevel: LogEventLevel.Information,
                standardErrorFromLevel: LogEventLevel.Verbose,
                outputTemplate: "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}")
            .WriteTo.File(
                path: logPath,
                restrictedToMinimumLevel: LogEventLevel.Verbose,
                rollingInterval: RollingInterval.Day,
                retainedFileCountLimit: 14,
                outputTemplate: "[{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}")
            .CreateLogger();

        return (logger, logsDir);
    }

    /// <summary>
    /// Resolve the per-run logs directory under <c>%LOCALAPPDATA%</c>
    /// without creating it. Used in <c>--dry-run</c> tests where we
    /// want a deterministic path without IO.
    /// </summary>
    public static string ResolveLogsDirectory(string runId)
    {
        var local = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData,
            Environment.SpecialFolderOption.DoNotVerify);
        return Path.Combine(local, "PRISM.Visualiser", "runs", runId, "logs");
    }
}
