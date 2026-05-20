// PRISM.Agent — Windows service entrypoint.
//
// Phase 3: real conversion path. Hosts Rhino 8 via Rhino.Inside, opens
// any supported CAD/mesh file, runs the OrbitConnector.Rhino send
// pipeline headlessly, and uploads ORBIT objects + blobs to orbit-server.

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;
using PRISM.Agent.Config;
using PRISM.Agent.Pipeline;
using PRISM.Agent.Rhino;
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

        if (OperatingSystem.IsWindows())
            builder.Logging.AddEventLog(s => s.SourceName = "PRISM.Agent");

        var cfg = AgentConfig.Load(args.FirstOrDefault());
        builder.Services.AddSingleton(cfg);

        builder.Services.AddSingleton(sp =>
            new WsClient(new Uri(cfg.PrismUrl), sp.GetRequiredService<ILogger<WsClient>>()));

        // Rhino host is a singleton — only one Rhino instance can live in a process.
        builder.Services.AddSingleton<RhinoHost>(sp => new RhinoHost(
            sp.GetRequiredService<ILogger<RhinoHost>>(), cfg.RhinoExecutablePath));

        builder.Services.AddSingleton<RhinoFileOpener>();
        builder.Services.AddTransient<ConvertJob>();
        builder.Services.AddSingleton<WorkerSlotPool>(sp => new WorkerSlotPool(
            sp.GetRequiredService<ILogger<WorkerSlotPool>>(),
            () => sp.GetRequiredService<ConvertJob>(),
            sp.GetRequiredService<WsClient>(),
            cfg.Slots));

        builder.Services.AddSingleton<AgentMessageDispatcher>();
        builder.Services.AddHostedService<AgentService>();

        var host = builder.Build();

        // Force dispatcher + slot pool to materialise so their event subscriptions run.
        _ = host.Services.GetRequiredService<WorkerSlotPool>();
        _ = host.Services.GetRequiredService<AgentMessageDispatcher>();

        await host.RunAsync();
    }
}
