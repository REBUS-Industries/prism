using System.Net.Http;
using Microsoft.Extensions.Logging;
using Orbit.Sdk.Api;
using Orbit.Sdk.Transport;
using OrbitConnector.Rhino.Models;
using OrbitConnector.Rhino.Pipeline;
using PRISM.Agent.Rhino;
using PRISM.Agent.Ws;
using PRISM.Contracts;

namespace PRISM.Agent.Pipeline;

/// <summary>
/// Single end-to-end conversion: download -&gt; open -&gt; pipeline -&gt; upload.
/// One instance per assigned job. Reports progress + final status via WS.
/// </summary>
public sealed class ConvertJob
{
    readonly ILogger<ConvertJob> _log;
    readonly RhinoHost _host;
    readonly RhinoFileOpener _opener;
    readonly WsClient _ws;

    public ConvertJob(ILogger<ConvertJob> log, RhinoHost host, RhinoFileOpener opener, WsClient ws)
    {
        _log = log; _host = host; _opener = opener; _ws = ws;
    }

    public async Task RunAsync(AssignData assign, CancellationToken ct)
    {
        var started = DateTime.UtcNow;
        await Progress(assign.JobId, "downloading", 1, $"downloading {assign.FileName}");

        string tempPath = await DownloadAsync(assign, ct);
        try
        {
            await Progress(assign.JobId, "opening", 5, "opening in Rhino");
            var doc = _opener.OpenInto(_host, tempPath, assign.Format);

            await Progress(assign.JobId, "preparing", 10, "preparing conversion");
            var card = AssignToCard(assign);
            using var transport = new ServerTransport(assign.OrbitServerUrl, assign.ProjectId, assign.OrbitToken);
            var client = new OrbitClient(assign.OrbitServerUrl, assign.OrbitToken);
            var pipeline = new RhinoSendPipeline();

            var prog = new Progress<(string status, int percent)>(t =>
            {
                _ = Progress(assign.JobId, t.status, t.percent, t.status);
            });

            await Progress(assign.JobId, "converting", 15, "running conversion pipeline");
            string versionId = await pipeline.SendAsync(card, doc, transport, client, prog, ct);

            var versionUrl = $"{assign.OrbitServerUrl.TrimEnd('/')}/projects/{assign.ProjectId}/models/{assign.ModelId}";

            await _ws.SendAsync(MessageType.Complete, new CompleteData
            {
                JobId = assign.JobId,
                VersionUrl = versionUrl,
                VersionId = versionId,
                Stats = new CompleteStats { ElapsedMs = (long)(DateTime.UtcNow - started).TotalMilliseconds },
            });

            doc.Dispose();
        }
        finally
        {
            TryDelete(tempPath);
        }
    }

    async Task<string> DownloadAsync(AssignData assign, CancellationToken ct)
    {
        var dir = Path.Combine(Path.GetTempPath(), "PRISM.Agent", "jobs");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, $"{assign.JobId}{assign.Format}");

        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        using var res = await http.GetAsync(assign.FileUrl, HttpCompletionOption.ResponseHeadersRead, ct);
        res.EnsureSuccessStatusCode();
        using var src = await res.Content.ReadAsStreamAsync(ct);
        using var dst = File.Create(path);
        await src.CopyToAsync(dst, ct);
        _log.LogInformation("downloaded {Path} ({Bytes} bytes)", path, new FileInfo(path).Length);
        return path;
    }

    static ConnectorCard AssignToCard(AssignData a)
    {
        var card = new ConnectorCard
        {
            Type = CardType.Send,
            Target = ServerTarget.Prod,  // PRISM dispatches per orbit_target on the job row; the agent does not need to pick a target
            ProjectId = a.ProjectId,
            ModelId = a.ModelId,
            ModelName = a.ModelName,
            LayerMode = a.Options?.IncludedLayers is { Length: > 0 } ? LayerMode.ByLayer : LayerMode.All,
            IncludedLayers = (a.Options?.IncludedLayers ?? Array.Empty<string>()).ToList(),
        };
        return card;
    }

    Task Progress(string jobId, string stage, double percent, string? message)
    {
        return _ws.SendAsync(MessageType.Progress, new ProgressData
        {
            JobId = jobId, Stage = stage, Percent = percent, Message = message,
        }).AsTask();
    }

    void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (Exception err) { _log.LogDebug(err, "best-effort cleanup of {Path} failed", path); }
    }
}
