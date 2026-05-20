// PRISM.Agent — Windows service entrypoint.
// Phase 0 scaffold: just enough to boot, log a heartbeat, and exit cleanly.
// Phase 2 wires the WS client to PRISM server.
// Phase 3 wires Rhino.Inside + the converter pipeline from
// vendor/orbit-monorepo/Connectors/src/OrbitConnector.Rhino.Core/.

using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;

namespace PRISM.Agent;

public static class Program
{
    public static async Task Main(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);

        builder.Services.AddWindowsService(opts =>
        {
            opts.ServiceName = "PRISMAgent";
        });

        builder.Logging
            .ClearProviders()
            .AddConsole()
            .AddEventLog(settings => { settings.SourceName = "PRISM.Agent"; });

        // Phase 2: register IHostedService for WsClient + WorkerSlot pool.
        // builder.Services.AddSingleton<AgentConfig>(_ => AgentConfig.Load(args));
        // builder.Services.AddSingleton<IWsClient, WsClient>();
        // builder.Services.AddHostedService<AgentService>();

        builder.Services.AddHostedService<HeartbeatService>();

        var host = builder.Build();
        await host.RunAsync();
    }
}

/// <summary>Phase 0 stand-in so the process has a HostedService to keep it alive.</summary>
internal sealed class HeartbeatService(ILogger<HeartbeatService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        log.LogInformation("PRISM.Agent phase-0 stub started");
        while (!stoppingToken.IsCancellationRequested)
        {
            log.LogDebug("heartbeat");
            try { await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken); }
            catch (TaskCanceledException) { break; }
        }
        log.LogInformation("PRISM.Agent stopping");
    }
}
