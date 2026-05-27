using System.Text.Json;
using System.Text.Json.Serialization;

using PRISM.Visualiser.Orchestrator.Models;

namespace PRISM.Visualiser.Orchestrator.Ipc;

/// <summary>
/// Writes a single JSON line on stdout terminated by <c>\n</c>, which
/// the PRISM.Agent host parses to wire up the player + signalling URLs
/// to the PRISM server. The protocol is intentionally one-line-per-event
/// so the agent can pipe stdout through a simple <c>ReadLineAsync</c>
/// loop without a streaming JSON parser.
/// </summary>
public static class ReadyHandshake
{
    /// <summary>
    /// Default serializer options. <see cref="JsonIgnoreCondition.WhenWritingNull"/>
    /// drops the optional <see cref="ReadyEvent.Error"/> field on the
    /// happy path so a successful event matches the Phase B schema doc
    /// byte-for-byte.
    /// </summary>
    public static readonly JsonSerializerOptions SerializerOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    /// <summary>
    /// Serialise <paramref name="evt"/> and write it as a single line to
    /// <paramref name="writer"/>. Defaults to <see cref="Console.Out"/>;
    /// tests inject a <see cref="StringWriter"/> for shape assertions.
    /// </summary>
    public static void Write(ReadyEvent evt, TextWriter? writer = null)
    {
        ArgumentNullException.ThrowIfNull(evt);
        var json = Serialize(evt);
        var target = writer ?? Console.Out;
        target.Write(json);
        target.Write('\n');
        target.Flush();
    }

    /// <summary>Serialise <paramref name="evt"/> without writing anywhere.</summary>
    public static string Serialize(ReadyEvent evt)
    {
        ArgumentNullException.ThrowIfNull(evt);
        return JsonSerializer.Serialize(evt, SerializerOptions);
    }
}
