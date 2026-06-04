using System.Collections.Concurrent;
using System.Threading.Channels;

namespace PRISM.Agent.Visualiser;

/// <summary>
/// In-process tap, ring buffer, and pub/sub for the Unreal Engine /
/// orchestrator console output the agent ingests from the visualiser
/// orchestrator child process (<c>prism-visualiser.exe</c>).
///
/// <para>
/// <see cref="Pipeline.VisualiserJob"/> publishes every orchestrator
/// stdout/stderr line here (which carries the UE <c>-game</c> / editor
/// console output, including the <c>ue-game</c> / <c>ue-editor-stream</c>
/// channel lines). The agent web UI's <c>/uelogs</c> page subscribes via
/// Server-Sent Events: on connect it replays the recent backlog from the
/// bounded ring buffer (so the last run's tail is visible even with no run
/// active), then live-appends new lines as they arrive.
/// </para>
///
/// <para>
/// The buffer is a fixed-size ring (oldest lines evicted) so it never grows
/// unbounded and persists across visualiser runs (this is a singleton —
/// nothing clears it on run exit). Each subscriber gets its own bounded
/// channel with <see cref="BoundedChannelFullMode.DropOldest"/>, so a slow or
/// stalled browser viewer can never block <see cref="Publish"/> or balloon
/// agent memory, and any number of viewers can watch concurrently.
/// </para>
///
/// <para>
/// No secrets are introduced here: the orchestrator already redacts
/// <c>-OrbitToken</c> / <c>-RebusApiKey</c> before they reach its console, and
/// this type only relays the lines verbatim — it never reads agent config or
/// the child's environment.
/// </para>
/// </summary>
public sealed class UeLogBroadcaster
{
    /// <summary>One captured console line.</summary>
    /// <param name="Seq">Monotonic sequence number (1-based) for ordering / de-dup on reconnect.</param>
    /// <param name="Ts">UTC ISO-8601 capture timestamp.</param>
    /// <param name="RunId">Visualiser run the line belongs to, or null when unknown.</param>
    /// <param name="Stream"><c>stdout</c> or <c>stderr</c>.</param>
    /// <param name="Text">The raw console line (already redacted upstream).</param>
    public sealed record Line(long Seq, string Ts, string? RunId, string Stream, string Text);

    /// <summary>Max lines retained in the ring buffer (oldest evicted past this).</summary>
    public const int MaxBufferLines = 4000;

    /// <summary>Per-subscriber live queue depth before the oldest queued line is dropped.</summary>
    const int SubscriberQueueDepth = 2000;

    readonly object _gate = new();
    readonly Queue<Line> _buffer = new();
    long _seq;

    readonly ConcurrentDictionary<Guid, Channel<Line>> _subscribers = new();

    /// <summary>Sequence number of the most recently published line (0 = none yet).</summary>
    public long LastSeq { get { lock (_gate) { return _seq; } } }

    /// <summary>Number of currently-connected live subscribers (SSE viewers).</summary>
    public int SubscriberCount => _subscribers.Count;

    /// <summary>
    /// Append a console line to the ring buffer and fan it out to every live
    /// subscriber. Non-blocking and safe to call from the orchestrator pump
    /// threads. Blank lines are ignored.
    /// </summary>
    public void Publish(string? runId, string stream, string? text)
    {
        if (string.IsNullOrEmpty(text)) return;

        Line line;
        lock (_gate)
        {
            line = new Line(
                ++_seq,
                DateTime.UtcNow.ToString("o"),
                string.IsNullOrWhiteSpace(runId) ? null : runId,
                stream,
                text);
            _buffer.Enqueue(line);
            while (_buffer.Count > MaxBufferLines) _buffer.Dequeue();
        }

        // Fan out. TryWrite never blocks; the bounded DropOldest channels
        // silently shed the oldest queued line for a viewer that has fallen
        // behind, so a slow client can't stall the pump or grow memory.
        foreach (var ch in _subscribers.Values)
            ch.Writer.TryWrite(line);
    }

    /// <summary>
    /// Snapshot the most recent <paramref name="max"/> buffered lines (all of
    /// them when <paramref name="max"/> &lt;= 0 or exceeds the buffer), in
    /// arrival order. Used to seed a freshly-connected SSE viewer with the
    /// backlog before live tailing begins.
    /// </summary>
    public IReadOnlyList<Line> Snapshot(int max)
    {
        lock (_gate)
        {
            if (max <= 0 || max >= _buffer.Count) return _buffer.ToArray();
            return _buffer.Skip(_buffer.Count - max).ToArray();
        }
    }

    /// <summary>
    /// Register a live subscriber. Returns its id (pass to
    /// <see cref="Unsubscribe"/> on disconnect) and a reader that yields every
    /// line published after this call. The channel is bounded + DropOldest so
    /// it never blocks the publisher.
    /// </summary>
    public (Guid Id, ChannelReader<Line> Reader) Subscribe()
    {
        var ch = Channel.CreateBounded<Line>(new BoundedChannelOptions(SubscriberQueueDepth)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });
        var id = Guid.NewGuid();
        _subscribers[id] = ch;
        return (id, ch.Reader);
    }

    /// <summary>Drop a subscriber (idempotent). Call from the SSE handler's finally.</summary>
    public void Unsubscribe(Guid id)
    {
        if (_subscribers.TryRemove(id, out var ch))
            ch.Writer.TryComplete();
    }
}
