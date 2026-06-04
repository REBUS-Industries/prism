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
/// Features: auto-scroll (pin-to-bottom) toggle, an <b>include</b> text filter
/// AND a multi-pattern <b>ignore</b> (exclude) filter — a line is shown only
/// when it passes the include filter (if any) AND matches no ignore pattern.
/// Both filters are case-insensitive substring matches, persisted in
/// <c>localStorage</c>, and applied to both the replayed backlog and live SSE
/// lines. Also: clear / clear-ignore buttons, double-click-to-ignore, a
/// "showing X of Y" counter when filtering is active, and a connection-status
/// indicator backed by the browser's native <c>EventSource</c> auto-reconnect.
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
    display: flex; align-items: center; gap: 12px 14px; flex-wrap: wrap;
    padding: 10px 14px; background: var(--bg-bar);
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header h1 .accent { color: var(--orbit-primary); }
  header a { color: var(--text-dim); text-decoration: none; font-size: 13px; }
  header a:hover { color: var(--text); }
  .spacer { flex: 1 1 auto; }
  .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .field { display: flex; flex-direction: column; gap: 2px; }
  .field > .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-dim); }
  .toolbar input[type=text], .toolbar textarea {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 8px; font-size: 13px;
    font-family: "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  }
  .toolbar input[type=text] { min-width: 210px; }
  .toolbar textarea { min-width: 230px; height: 30px; resize: both; line-height: 1.3; white-space: pre; }
  .toolbar input[type=text]:focus, .toolbar textarea:focus { outline: none; border-color: var(--orbit-primary); }
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
  .count.filtering { color: var(--warn); }
  .hint { font-size: 11px; color: var(--text-dim); padding: 4px 14px 0; }
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
    <div class="field">
      <span class="lbl">Include</span>
      <input type="text" id="filter" placeholder="show only lines containing…" autocomplete="off" />
    </div>
    <div class="field">
      <span class="lbl">Ignore (one per line / comma-sep)</span>
      <textarea id="ignore" placeholder="hide lines containing any of these…" autocomplete="off" spellcheck="false"></textarea>
    </div>
    <button class="btn" id="clearIgnore" title="Clear the ignore patterns">✕ ignore</button>
    <label><input type="checkbox" id="autoscroll" checked /> auto-scroll</label>
    <label><input type="checkbox" id="showmeta" checked /> timestamps</label>
    <button class="btn" id="clear" title="Clear the view (does not affect the agent buffer)">Clear</button>
    <span class="count" id="count">0 lines</span>
    <span class="status"><span class="dot connecting" id="dot"></span><span id="statusText">connecting…</span></span>
  </div>
</header>
<div class="hint">Double-click a line (or select text first) to add it to the ignore list. Filters are case-insensitive and saved in this browser.</div>
<div id="log"><div class="empty" id="empty">Waiting for UE console output… start a visualiser run on this workstation, or the last run's tail will appear here.</div></div>

<script>
(function () {
  var logEl = document.getElementById('log');
  var emptyEl = document.getElementById('empty');
  var filterEl = document.getElementById('filter');
  var ignoreEl = document.getElementById('ignore');
  var autoscrollEl = document.getElementById('autoscroll');
  var showmetaEl = document.getElementById('showmeta');
  var countEl = document.getElementById('count');
  var dotEl = document.getElementById('dot');
  var statusTextEl = document.getElementById('statusText');

  var MAX_DOM_LINES = 5000;   // cap rendered nodes so the page can't grow unbounded
  var total = 0;              // rows currently in the DOM buffer
  var shown = 0;              // visible rows (after include + ignore filters)
  var lastSeq = 0;
  var includeText = '';
  var ignorePatterns = [];    // lowercased substrings; line hidden if it matches ANY

  var LS_INCLUDE = 'prism.uelogs.include';
  var LS_IGNORE  = 'prism.uelogs.ignore';

  function setStatus(kind, text) {
    dotEl.className = 'dot ' + kind;
    statusTextEl.textContent = text;
  }

  function filtering() { return includeText !== '' || ignorePatterns.length > 0; }

  function updateCount() {
    if (filtering()) {
      countEl.textContent = 'showing ' + shown.toLocaleString() + ' of ' + total.toLocaleString();
      countEl.classList.add('filtering');
    } else {
      countEl.textContent = total.toLocaleString() + ' lines';
      countEl.classList.remove('filtering');
    }
  }

  // A line is visible when it passes the include filter (if any) AND matches
  // no ignore pattern. Ignore always wins over include.
  function isVisible(text) {
    var t = text.toLowerCase();
    if (includeText !== '' && t.indexOf(includeText) === -1) return false;
    for (var i = 0; i < ignorePatterns.length; i++) {
      if (ignorePatterns[i] && t.indexOf(ignorePatterns[i]) !== -1) return false;
    }
    return true;
  }

  function parseIgnore(raw) {
    return raw.split(/[\n,]/).map(function (s) { return s.trim().toLowerCase(); })
              .filter(function (s) { return s.length > 0; });
  }

  function save() {
    try {
      localStorage.setItem(LS_INCLUDE, filterEl.value);
      localStorage.setItem(LS_IGNORE, ignoreEl.value);
    } catch (e) { /* storage disabled — non-fatal */ }
  }

  function load() {
    try {
      var inc = localStorage.getItem(LS_INCLUDE);
      if (inc !== null) filterEl.value = inc;
      var ig = localStorage.getItem(LS_IGNORE);
      if (ig !== null) ignoreEl.value = ig;
    } catch (e) { /* storage disabled */ }
    includeText = filterEl.value.trim().toLowerCase();
    ignorePatterns = parseIgnore(ignoreEl.value);
  }

  function fmtTime(iso) {
    // HH:MM:SS from an ISO-8601 UTC stamp, shown in local time.
    try { var d = new Date(iso); return d.toLocaleTimeString(); } catch (e) { return ''; }
  }

  function append(item) {
    if (emptyEl) { emptyEl.remove(); emptyEl = null; }

    var visible = isVisible(item.text);

    var row = document.createElement('div');
    row.className = 'row ' + (item.stream === 'stderr' ? 'stderr' : 'stdout');
    row.dataset.text = item.text;
    row.dataset.visible = visible ? '1' : '0';

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

    if (!visible) row.style.display = 'none';
    logEl.appendChild(row);
    total++; if (visible) shown++;

    // Enforce the DOM cap, keeping the counters consistent with what's removed.
    while (logEl.childElementCount > MAX_DOM_LINES) {
      var first = logEl.firstChild;
      if (first && first.dataset && first.dataset.visible === '1') shown--;
      if (first && first.classList && first.classList.contains('row')) total--;
      logEl.removeChild(first);
    }
    updateCount();

    if (visible && autoscrollEl.checked) logEl.scrollTop = logEl.scrollHeight;
  }

  // Re-evaluate every buffered row against the current filters.
  function applyFilters() {
    includeText = filterEl.value.trim().toLowerCase();
    ignorePatterns = parseIgnore(ignoreEl.value);
    save();
    var rows = logEl.querySelectorAll('.row');
    total = rows.length; shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var vis = isVisible(rows[i].dataset.text || '');
      rows[i].style.display = vis ? '' : 'none';
      rows[i].dataset.visible = vis ? '1' : '0';
      if (vis) shown++;
    }
    updateCount();
    if (autoscrollEl.checked) logEl.scrollTop = logEl.scrollHeight;
  }

  filterEl.addEventListener('input', applyFilters);
  ignoreEl.addEventListener('input', applyFilters);

  document.getElementById('clearIgnore').addEventListener('click', function () {
    ignoreEl.value = '';
    applyFilters();
  });

  document.getElementById('clear').addEventListener('click', function () {
    logEl.innerHTML = '';
    total = 0; shown = 0; updateCount();
  });

  showmetaEl.addEventListener('change', function () {
    var metas = logEl.querySelectorAll('.row .meta');
    for (var i = 0; i < metas.length; i++) metas[i].style.display = showmetaEl.checked ? '' : 'none';
  });

  // Double-click a line (or a selection within it) to add an ignore pattern.
  logEl.addEventListener('dblclick', function (e) {
    var row = e.target.closest ? e.target.closest('.row') : null;
    if (!row) return;
    var sel = '';
    try { sel = (window.getSelection().toString() || '').trim(); } catch (x) { sel = ''; }
    var seed = sel || (row.dataset.text || '');
    var pat = prompt('Hide log lines containing:', seed);
    if (pat === null) return;
    pat = pat.trim();
    if (!pat) return;
    ignoreEl.value = ignoreEl.value.replace(/\s+$/, '');
    ignoreEl.value = ignoreEl.value ? (ignoreEl.value + '\n' + pat) : pat;
    applyFilters();
  });

  var es = null;
  function connect() {
    setStatus('connecting', 'connecting…');
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

  load();
  updateCount();
  connect();
  window.addEventListener('beforeunload', function () { if (es) es.close(); });
})();
</script>
</body>
</html>
""";
}
