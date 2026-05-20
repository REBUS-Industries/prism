// PRISM.Agent — Windows service entrypoint.
//
// Phase 2: connects to PRISM via WSS, sends `hello`, heartbeats, and
// acks dispatched jobs as fail("not implemented") so the orchestrator
// can be tested end-to-end. Phase 3 swaps the dispatcher to actually
// drive Rhino.Inside.

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;
using PRISM.Agent.Config;
using PRISM.Agent.Ws;

namespace PRISM.Agent;

public static class Program
{
    public static async Task Main(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);

        builder.Services.AddWindowsService(opts => opts.ServiceName = "PRISMAgent");

        builder.Logging
            .ClearProviders()
            .AddConsole();

        // OS event log is helpful when running under SCM. Skip on non-Windows
        // dev hosts (where the eventlog API throws at startup).
        if (OperatingSystem.IsWindows())
        {
            builder.Logging.AddEventLog(s => s.SourceName = "PRISM.Agent");
        }

        var cfg = AgentConfig.Load(args.FirstOrDefault());
        builder.Services.AddSingleton(cfg);

        builder.Services.AddSingleton(sp =>
        {
            var log = sp.GetRequiredService<ILogger<WsClient>>();
            return new WsClient(new Uri(cfg.PrismUrl), log);
        });
        builder.Services.AddSingleton<AgentMessageDispatcher>();
        builder.Services.AddHostedService<AgentService>();

        var host = builder.Build();

        // Force dispatcher to materialise so its event subscription on WsClient runs.
        _ = host.Services.GetRequiredService<AgentMessageDispatcher>();

        await host.RunAsync();
    }
}
