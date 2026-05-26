namespace PRISM.Agent.WebUi;

/// <summary>
/// Single-file HTML page served at <c>GET /</c>.  Vanilla CSS + JS so the
/// agent's self-contained publish does not need a frontend build step.
/// Styled to roughly mirror the PRISM admin design system (dark slate +
/// orange accent).
/// </summary>
internal static class IndexHtml
{
    public const string Body = """
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PRISM Agent</title>
<style>
  :root {
    --bg: #0f172a;
    --bg-2: #111827;
    --panel: #1e293b;
    --panel-2: #273345;
    --border: #334155;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --accent: #f97316;
    --accent-2: #ea580c;
    --green: #10b981;
    --red: #ef4444;
    --amber: #f59e0b;
    --shadow: 0 4px 20px rgba(0,0,0,.35);
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Inter, system-ui, sans-serif;
    background: var(--bg); color: var(--text);
    min-height: 100vh;
  }
  header {
    display:flex; align-items:center; justify-content:space-between;
    padding: 18px 28px;
    background: var(--bg-2); border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 5;
  }
  header h1 {
    margin:0; font-size:18px; font-weight:600; letter-spacing:.3px;
    display:flex; align-items:center; gap:10px;
  }
  header h1 .dot {
    width:10px; height:10px; border-radius:50%; background: var(--amber);
    box-shadow: 0 0 10px currentColor;
  }
  header h1.connected .dot { background: var(--green); }
  header h1.paused    .dot { background: var(--muted); }
  header h1.offline   .dot { background: var(--red); }
  header .meta { color: var(--muted); font-size:12px; }

  main { max-width: 980px; margin: 0 auto; padding: 24px 28px 80px; }

  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius); margin-bottom: 22px; box-shadow: var(--shadow);
  }
  .panel h2 {
    margin: 0; padding: 14px 18px;
    font-size: 13px; text-transform: uppercase; letter-spacing: .12em;
    color: var(--muted); border-bottom: 1px solid var(--border);
  }
  .panel .body { padding: 18px; }

  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap: 12px; }
  .stat { background: var(--panel-2); border-radius: 8px; padding: 12px 14px; }
  .stat .label { color: var(--muted); font-size:11px; text-transform: uppercase; letter-spacing:.1em; margin-bottom:4px; }
  .stat .value { font-size:18px; font-weight:600; }

  label { display:block; margin: 12px 0 6px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing:.08em; }
  input[type="text"], input[type="number"], input[type="url"], select {
    width: 100%; background: var(--bg-2); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); padding: 9px 11px; font: inherit;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }

  .row { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap: 14px; }

  .toggle-row { display:flex; gap: 14px; flex-wrap: wrap; margin-top: 6px; }
  .toggle {
    display:flex; align-items:center; gap:8px;
    background: var(--panel-2); padding: 8px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid transparent; user-select: none;
  }
  .toggle input { accent-color: var(--accent); }
  .toggle.checked { border-color: var(--accent); }

  .actions { display:flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
  button {
    background: var(--accent); color: #000; font-weight: 600;
    border: none; border-radius: 6px; padding: 10px 18px; cursor: pointer;
    font-size: 13px; letter-spacing: .02em;
    transition: background .15s ease;
  }
  button:hover { background: var(--accent-2); }
  button.secondary { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); }
  button.secondary:hover { background: #374151; }
  button.danger { background: var(--red); color: #fff; }
  button.danger:hover { background: #dc2626; }
  button:disabled { opacity:.45; cursor:not-allowed; }

  .pill {
    display:inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 600; background: var(--panel-2); color: var(--muted);
  }
  .pill.green { background: rgba(16,185,129,.15); color: var(--green); }
  .pill.red   { background: rgba(239,68,68,.15);  color: var(--red); }
  .pill.amber { background: rgba(245,158,11,.15); color: var(--amber); }

  .formats {
    display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;
  }
  .formats code {
    background: var(--bg-2); border: 1px solid var(--border);
    padding: 3px 8px; border-radius: 4px; font-size:12px; color: var(--text);
  }

  pre.logs {
    background: #050b18; color: #cbd5e1; border: 1px solid var(--border);
    border-radius: 6px; padding: 12px;
    height: 360px; overflow:auto; margin: 0;
    font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace;
  }

  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px 18px; box-shadow: var(--shadow);
    color: var(--text); font-size: 13px;
    transform: translateY(20px); opacity: 0; pointer-events: none;
    transition: transform .2s ease, opacity .2s ease;
    z-index: 50;
  }
  .toast.show { transform: translateY(0); opacity: 1; }
  .toast.error { border-color: var(--red); }
  .toast.warn { border-color: var(--amber); }

  .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .danger-zone { border-color: rgba(239,68,68,.4); }
</style>
</head>
<body>

<header>
  <h1 id="title" class="offline"><span class="dot"></span> PRISM Agent</h1>
  <div class="meta">
    <span id="version">—</span>
    &nbsp;·&nbsp;
    <span id="machineId">—</span>
  </div>
</header>

<main>

  <section class="panel">
    <h2>Status</h2>
    <div class="body">
      <div class="grid">
        <div class="stat"><div class="label">Connection</div><div class="value" id="connState">—</div></div>
        <div class="stat"><div class="label">Watcher</div><div class="value" id="watcherState">—</div></div>
        <div class="stat"><div class="label">Slots busy</div><div class="value" id="slotsBusy">—</div></div>
        <div class="stat"><div class="label">Slots total</div><div class="value" id="slotsTotal">—</div></div>
      </div>
      <div class="actions">
        <button id="btnPause" class="danger">⏸ Pause watcher</button>
        <button id="btnResume" class="secondary">▶ Resume watcher</button>
        <button id="btnRefresh" class="secondary">↻ Refresh</button>
      </div>
      <p class="hint">
        Pausing the watcher disconnects this agent from the PRISM server, so
        new conversion / layer / receive jobs are routed to other workstations.
        Jobs already running on this slot finish normally.
      </p>
    </div>
  </section>

  <section class="panel">
    <h2>Connection</h2>
    <div class="body">
      <div class="row">
        <div>
          <label>PRISM server URL</label>
          <input type="url" id="prismUrl" placeholder="wss://prism.rebus.industries/ws/agent" />
          <p class="hint">Restart the agent after changing this.</p>
        </div>
        <div>
          <label>Node name</label>
          <input type="text" id="nodeName" />
        </div>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Capacity</h2>
    <div class="body">
      <div class="row">
        <div>
          <label>Slots (1–8)</label>
          <input type="number" id="slots" min="1" max="8" />
          <p class="hint">
            Number of jobs this workstation can run in parallel.  Rhino is
            single-instance, so slots mainly let the agent accept the next job
            while one is finishing up its upload phase.
          </p>
        </div>
        <div>
          <label>Roles this agent will run</label>
          <div class="toggle-row" id="roles"></div>
          <p class="hint">
            Disable a role to opt this workstation out of that work type
            (e.g. layering-only or receive-only nodes).
          </p>
        </div>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Rhino &amp; logs</h2>
    <div class="body">
      <div class="row">
        <div>
          <label>Rhino version</label>
          <select id="rhinoVersion">
            <option value="auto">auto (highest installed)</option>
            <option value="8">Rhino 8</option>
            <option value="9">Rhino 9 (when released)</option>
          </select>
          <p class="hint">Restart the agent after changing this.</p>
        </div>
        <div>
          <label>Log directory</label>
          <input type="text" id="logDir" />
        </div>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Web UI binding</h2>
    <div class="body">
      <div class="row">
        <div>
          <label>Web UI port</label>
          <input type="number" id="webUiPort" min="0" max="65535" />
          <p class="hint">Set to 0 to disable the web UI entirely. Restart required.</p>
        </div>
        <div>
          <label>Bind to all interfaces (LAN-reachable)</label>
          <div class="toggle-row">
            <label class="toggle">
              <input type="checkbox" id="webUiBindAll" />
              Allow remote access
            </label>
          </div>
          <p class="hint">
            By default the UI binds to <code>localhost</code> only.  Enabling
            this exposes <em>unauthenticated</em> agent settings on the LAN.
            Restart required.
          </p>
        </div>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Supported formats</h2>
    <div class="body">
      <div class="formats" id="supportedFormats"></div>
      <p class="hint">
        These are the file extensions the agent reports to the PRISM server in
        its <code>hello</code> message.  Routing decisions on the server use
        this list.
      </p>
    </div>
  </section>

  <section class="panel">
    <h2>Save</h2>
    <div class="body">
      <div class="actions">
        <button id="btnSave">💾 Save settings</button>
        <button id="btnReload" class="secondary">↺ Discard changes</button>
      </div>
      <p class="hint">
        Changes that take effect live: <code>nodeName</code>, <code>slots</code>,
        <code>roles</code>, <code>logDir</code>.  Restart-required: server URL,
        Rhino version, web UI port/binding.
      </p>
    </div>
  </section>

  <section class="panel">
    <h2>Logs (last 500)</h2>
    <div class="body">
      <pre id="logs" class="logs">loading…</pre>
      <div class="actions">
        <button id="btnLogs" class="secondary">↻ Refresh logs</button>
      </div>
    </div>
  </section>

</main>

<div class="toast" id="toast"></div>

<script>
  const $ = (id) => document.getElementById(id);

  let state = null;
  let dirty = false;

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  }

  function toast(msg, kind = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show ' + kind;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'toast'; }, 3000);
  }

  function applyState(s) {
    state = s;

    // Header
    $('version').textContent = `v${s.agent.version}`;
    $('machineId').textContent = s.agent.machineId.slice(0, 8) + '…';

    const title = $('title');
    title.classList.remove('connected', 'paused', 'offline');
    if (s.agent.paused)         title.classList.add('paused');
    else if (s.agent.connected) title.classList.add('connected');
    else                        title.classList.add('offline');

    // Status panel
    $('connState').textContent = s.agent.connected
      ? '🟢 Connected'
      : '🔴 Disconnected';
    $('watcherState').textContent = s.agent.paused
      ? '⏸ Paused'
      : '▶ Running';
    $('slotsBusy').textContent = s.agent.slotsBusy;
    $('slotsTotal').textContent = s.config.slots;

    $('btnPause').disabled  = s.agent.paused;
    $('btnResume').disabled = !s.agent.paused;

    // Form fields (only when not dirty so user input isn't clobbered)
    if (!dirty) {
      $('prismUrl').value     = s.config.prismUrl;
      $('nodeName').value     = s.config.nodeName;
      $('slots').value        = s.config.slots;
      $('rhinoVersion').value = s.config.rhinoVersion;
      $('logDir').value       = s.config.logDir;
      $('webUiPort').value    = s.config.webUiPort;
      $('webUiBindAll').checked = !!s.config.webUiBindAll;
      renderRoles(s.availableRoles, new Set(s.config.roles));
    }

    // Formats
    const formats = $('supportedFormats');
    formats.innerHTML = '';
    for (const ext of s.agent.supportedFormats) {
      const c = document.createElement('code');
      c.textContent = ext;
      formats.appendChild(c);
    }
  }

  function renderRoles(allRoles, enabled) {
    const host = $('roles');
    host.innerHTML = '';
    for (const role of allRoles) {
      const wrap = document.createElement('label');
      wrap.className = 'toggle' + (enabled.has(role) ? ' checked' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = enabled.has(role);
      cb.dataset.role = role;
      cb.addEventListener('change', () => {
        wrap.classList.toggle('checked', cb.checked);
        markDirty();
      });
      wrap.appendChild(cb);
      wrap.append(' ' + role);
      host.appendChild(wrap);
    }
  }

  function markDirty() {
    dirty = true;
    $('btnSave').textContent = '💾 Save settings *';
  }

  function clearDirty() {
    dirty = false;
    $('btnSave').textContent = '💾 Save settings';
  }

  function collectUpdate() {
    const roles = Array.from(document.querySelectorAll('#roles input:checked'))
      .map((el) => el.dataset.role);
    return {
      prismUrl:     $('prismUrl').value.trim(),
      nodeName:     $('nodeName').value.trim(),
      slots:        Number($('slots').value),
      roles,
      rhinoVersion: $('rhinoVersion').value,
      logDir:       $('logDir').value.trim(),
      webUiPort:    Number($('webUiPort').value),
      webUiBindAll: $('webUiBindAll').checked,
    };
  }

  async function refresh() {
    try {
      const s = await api('/api/state');
      applyState(s);
    } catch (err) {
      toast('Failed to load state: ' + err.message, 'error');
    }
  }

  async function refreshLogs() {
    try {
      const r = await api('/api/logs?n=500');
      $('logs').textContent = r.lines.join('\n') || '(no log lines yet)';
      $('logs').scrollTop = $('logs').scrollHeight;
    } catch (err) {
      $('logs').textContent = 'Failed to load logs: ' + err.message;
    }
  }

  $('btnPause').addEventListener('click', async () => {
    try {
      const r = await api('/api/watcher/pause', { method: 'POST', body: '{}' });
      applyState(r.state);
      toast('Watcher paused', 'warn');
    } catch (err) { toast(err.message, 'error'); }
  });

  $('btnResume').addEventListener('click', async () => {
    try {
      const r = await api('/api/watcher/resume', { method: 'POST', body: '{}' });
      applyState(r.state);
      toast('Watcher resumed');
    } catch (err) { toast(err.message, 'error'); }
  });

  $('btnRefresh').addEventListener('click', refresh);
  $('btnLogs').addEventListener('click', refreshLogs);
  $('btnReload').addEventListener('click', () => { clearDirty(); refresh(); });

  $('btnSave').addEventListener('click', async () => {
    try {
      const update = collectUpdate();
      const r = await api('/api/config', { method: 'POST', body: JSON.stringify(update) });
      clearDirty();
      applyState(r.state);
      toast(r.restartRequired
        ? 'Saved. Restart the agent to apply server URL / Rhino / web UI changes.'
        : 'Saved.',
        r.restartRequired ? 'warn' : '');
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
  });

  // Track edits in plain inputs so we don't clobber typing on poll.
  for (const id of ['prismUrl','nodeName','slots','rhinoVersion','logDir','webUiPort']) {
    $(id).addEventListener('input', markDirty);
  }
  $('webUiBindAll').addEventListener('change', markDirty);

  // First load + poll every 4 s.
  refresh().then(refreshLogs);
  setInterval(refresh, 4000);
</script>
</body>
</html>
""";
}
