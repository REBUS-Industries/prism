using System.Text.Json;

using PRISM.Visualiser.Orchestrator.Ipc;
using PRISM.Visualiser.Orchestrator.Models;

using Xunit;

namespace PRISM.Visualiser.Orchestrator.Tests;

/// <summary>
/// JSON-shape parity tests for <see cref="ReadyHandshake"/>. The agent
/// parses these lines field-by-field, so any rename / case change is a
/// breaking wire-protocol bump. Keep the literal field names locked
/// down here.
/// </summary>
public class ReadyHandshakeTests
{
    [Fact]
    public void Write_Ready_EmitsSingleNewlineTerminatedJsonLine()
    {
        var evt = ReadyEvent.Ready(
            runId: "11111111-1111-1111-1111-111111111111",
            projectId: "p",
            modelId: "m",
            versionId: "v",
            playerUrl: "http://127.0.0.1:0/",
            signallingUrl: "ws://127.0.0.1:0/",
            streamerId: "orbit_11111111",
            ueProcessId: 0,
            signallingProcessId: 0,
            logsDir: @"C:\Users\test\AppData\Local\PRISM.Visualiser\runs\11111111\logs");

        using var sw = new StringWriter();
        ReadyHandshake.Write(evt, sw);
        var output = sw.ToString();

        Assert.EndsWith("\n", output);
        Assert.DoesNotContain("\r", output);
        // Stripped of the trailing newline, the line must be valid JSON.
        var jsonLine = output.TrimEnd('\n');
        Assert.DoesNotContain("\n", jsonLine);

        using var doc = JsonDocument.Parse(jsonLine);
        var root = doc.RootElement;

        Assert.Equal(ReadyEvent.SchemaName, root.GetProperty("schema").GetString());
        Assert.Equal("ready", root.GetProperty("status").GetString());
        Assert.Equal("11111111-1111-1111-1111-111111111111", root.GetProperty("runId").GetString());
        Assert.Equal("p", root.GetProperty("projectId").GetString());
        Assert.Equal("m", root.GetProperty("modelId").GetString());
        Assert.Equal("v", root.GetProperty("versionId").GetString());
        Assert.Equal("http://127.0.0.1:0/", root.GetProperty("playerUrl").GetString());
        Assert.Equal("ws://127.0.0.1:0/", root.GetProperty("signallingUrl").GetString());
        Assert.Equal("orbit_11111111", root.GetProperty("streamerId").GetString());
        Assert.Equal(0, root.GetProperty("ueProcessId").GetInt32());
        Assert.Equal(0, root.GetProperty("signallingProcessId").GetInt32());
        Assert.Contains("PRISM.Visualiser", root.GetProperty("logsDir").GetString()!);

        // The happy path must not carry an `error` field.
        Assert.False(root.TryGetProperty("error", out _),
            "Successful ready events must omit the optional `error` field.");
    }

    [Fact]
    public void Write_Failed_IncludesErrorAndZeroedRuntimeFields()
    {
        var evt = ReadyEvent.Failed(
            runId: "22222222-2222-2222-2222-222222222222",
            projectId: "p",
            modelId: "m",
            versionId: "v",
            logsDir: @"C:\logs",
            error: "boom");

        var line = ReadyHandshake.Serialize(evt);
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;

        Assert.Equal("failed", root.GetProperty("status").GetString());
        Assert.Equal("boom", root.GetProperty("error").GetString());
        Assert.Equal(string.Empty, root.GetProperty("playerUrl").GetString());
        Assert.Equal(string.Empty, root.GetProperty("signallingUrl").GetString());
        Assert.Equal(string.Empty, root.GetProperty("streamerId").GetString());
        Assert.Equal(0, root.GetProperty("ueProcessId").GetInt32());
        Assert.Equal(0, root.GetProperty("signallingProcessId").GetInt32());
    }

    [Fact]
    public void Write_ThrowsArgumentNull_OnNullEvent()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ReadyHandshake.Write(null!, new StringWriter()));
    }

    [Fact]
    public void Serialize_OutputIsCamelCaseAcrossAllRequiredFields()
    {
        var evt = ReadyEvent.Ready(
            runId: "r", projectId: "p", modelId: "m", versionId: "v",
            playerUrl: "http://127.0.0.1:0/",
            signallingUrl: "ws://127.0.0.1:0/",
            streamerId: "orbit_x",
            ueProcessId: 1, signallingProcessId: 2,
            logsDir: "L");
        var json = ReadyHandshake.Serialize(evt);

        foreach (var field in new[]
        {
            "schema","status","runId","projectId","modelId","versionId",
            "playerUrl","signallingUrl","streamerId","ueProcessId",
            "signallingProcessId","logsDir",
        })
        {
            Assert.Contains($"\"{field}\":", json);
        }
    }
}
