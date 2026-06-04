namespace PRISM.Agent.WebUi;

/// <summary>
/// Single-file HTML page served at <c>GET /uelogs</c>. A live, auto-scrolling
/// tail of the Unreal Engine / orchestrator console output, fed by the
/// Server-Sent Events endpoint <c>GET /api/uelogs/stream</c> (which replays the
/// recent backlog then live-appends new lines).
///
/// <para>
/// Vanilla CSS + JS (no build step, no dependencies), themed to match the main
/// agent page (<see cref="IndexHtml"/>): ORBIT orange brand, dark default.
/// Features: auto-scroll (pin-to-bottom) toggle, case-insensitive text filter,
/// clear button, line counter, and a connection-status indicator backed by the
/// browser's native <c>EventSource</c> auto-reconnect.
/// </para>
/// </summary>
internal static class UeLogsHtml
{
    public const string Template = """
<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PRISM Agent — UE console logs</title>
<style>
  :root {
    --orbit-primary: #e06238;
    --bg:        #0f1115;
    --bg-bar:    #171a21;
    --border:    #2a2f3a;
    --text:      #e6e8ec;
    --text-dim:  #9aa3b2;
    --stderr:    #e6e8ec;
    --stdout:    #8fb4ff;
    --ok:        #34d399;
    --warn:      #fbbf24;
    --err:       #f87171;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 10px 14px; background: var(--bg-bar);
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header h1 .accent { color: var(--orbit-primary); }
  header a { color: var(--text-dim); text-decoration: none; font-size: 13px; }
  header a:hover { color: var(--text); }
  .spacer { flex: 1 1 auto; }
  .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .toolbar input[type=text] {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 8px; font-size: 13px; min-width: 200px;
  }
  .toolbar label { font-size: 13px; color: var(--text-dim); display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; }
  .btn {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 10px; font-size: 13px; cursor: pointer;
  }
  .btn:hover { border-color: var(--orbit-primary); }
  .status { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-dim); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-dim); }
  .dot.live { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
  .dot.connecting { background: var(--warn); }
  .dot.down { background: var(--err); }
  .count { font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
  #log {
    flex: 1 1 auto; overflow-y: auto; padding: 8px 12px;
    font-family: "Cascadia Mono", Consolas, "Liberation Mono", monospace;
    font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
  }
  .row { display: flex; gap: 8px; }
  .row .meta { color: var(--text-dim); flex: 0 0 auto; }
  .row.stderr .txt { color: var(--stderr); }
  .row.stdout .txt { color: var(--stdout); }
  .row .rid { color: var(--orbit-primary); }
  .empty { color: var(--text-dim); padding: 16px 12px; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1><span class="accent">PRISM</span> · UE console</h1>
  <a href="/">← agent settings</a>
  <div class="spacer"></div>
  <div class="toolbar">
    <input type="text" id="filter" placeholder="filter (substring)…" autocomplete="off" />
    <label><input type="checkbox" id="autoscroll" checked /> auto-scroll</label>
    <label><input type="checkbox" id="showmeta" checked /> timestamps</label>
    <button class="btn" id="clear">Clear</button>
    <span class="count" id="count">0 lines</span>
    <span class="status"><span class="dot connecting" id="dot"></span><span id="statusText">connecting…</span></span>
  </div>
</header>
<div id="log"><div class="empty" id="empty">Waiting for UE console output… start a visualiser run on this workstation, or the last run's tail will appear here.</div></div>

<script>
(function () {
  var logEl = document.getElementById('log');
  var emptyEl = document.getElementById('empty');
  var filterEl = document.getElementById('filter');
  var autoscrollEl = document.getElementById('autoscroll');
  var showmetaEl = document.getElementById('showmeta');
  var countEl = document.getElementById('count');
  var dotEl = document.getElementById('dot');
  var statusTextEl = document.getElementById('statusText');

  var MAX_DOM_LINES = 5000;   // cap rendered nodes so the page can't grow unbounded
  var total = 0;
  var lastSeq = 0;
  var filterText = '';

  function setStatus(kind, text) {
    dotEl.className = 'dot ' + kind;
    statusTextEl.textContent = text;
  }
  function updateCount() { countEl.textContent = total.toLocaleString() + ' lines'; }

  function matches(text) {
    return filterText === '' || text.toLowerCase().indexOf(filterText) !== -1;
  }

  function fmtTime(iso) {
    // HH:MM:SS from an ISO-8601 UTC stamp, shown in local time.
    try { var d = new Date(iso); return d.toLocaleTimeString(); } catch (e) { return ''; }
  }

  function append(item) {
    if (emptyEl) { emptyEl.remove(); emptyEl = null; }

    var row = document.createElement('div');
    row.className = 'row ' + (item.stream === 'stderr' ? 'stderr' : 'stdout');
    row.dataset.text = item.text;

    if (showmetaEl.checked) {
      var meta = document.createElement('span');
      meta.className = 'meta';
      var rid = item.runId ? item.runId.slice(0, 8) : '--------';
      meta.innerHTML = fmtTime(item.ts) + ' <span class="rid">' + rid + '</span>';
      row.appendChild(meta);
    }
    var txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = item.text;
    row.appendChild(txt);

    if (!matches(item.text)) row.style.display = 'none';
    logEl.appendChild(row);
    total++;

    while (logEl.childElementCount > MAX_DOM_LINES) logEl.removeChild(logEl.firstChild);
    updateCount();

    if (autoscrollEl.checked) logEl.scrollTop = logEl.scrollHeight;
  }

  function applyFilter() {
    filterText = filterEl.value.trim().toLowerCase();
    var rows = logEl.querySelectorAll('.row');
    for (var i = 0; i < rows.length; i++) {
      var t = (rows[i].dataset.text || '').toLowerCase();
      rows[i].style.display = matches(t) ? '' : 'none';
    }
    if (autoscrollEl.checked) logEl.scrollTop = logEl.scrollHeight;
  }

  filterEl.addEventListener('input', applyFilter);
  document.getElementById('clear').addEventListener('click', function () {
    logEl.innerHTML = '';
    total = 0; updateCount();
  });
  // Re-render meta visibility cheaply by toggling a class would need re-build;
  // simplest is to reload the stream view on toggle.
  showmetaEl.addEventListener('change', function () {
    var metas = logEl.querySelectorAll('.row .meta');
    for (var i = 0; i < metas.length; i++) metas[i].style.display = showmetaEl.checked ? '' : 'none';
  });

  var es = null;
  function connect() {
    setStatus('connecting', 'connecting…');
    // Resume after lastSeq so a reconnect doesn't replay the whole backlog.
    var url = '/api/uelogs/stream?n=2000';
    es = new EventSource(url);
    es.onopen = function () { setStatus('live', 'live'); };
    es.onmessage = function (ev) {
      if (!ev.data) return;
      var item;
      try { item = JSON.parse(ev.data); } catch (e) { return; }
      if (item.seq && item.seq <= lastSeq) return; // de-dup across reconnects
      if (item.seq) lastSeq = item.seq;
      append(item);
    };
    es.onerror = function () {
      // EventSource auto-reconnects (honours the server's retry: hint).
      setStatus('down', 'reconnecting…');
    };
  }
  connect();
  window.addEventListener('beforeunload', function () { if (es) es.close(); });
})();
</script>
</body>
</html>
""";
}
