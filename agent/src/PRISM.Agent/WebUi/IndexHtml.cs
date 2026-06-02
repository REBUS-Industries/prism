namespace PRISM.Agent.WebUi;

/// <summary>
/// Single-file HTML page served at <c>GET /</c>.  Vanilla CSS + JS so the
/// agent's self-contained publish does not need a frontend build step.
///
/// Styling mirrors <c>PRISM/web/src/shared/designSystem.css</c> -- ORBIT
/// orange brand (<c>#e06238</c>), dark + light themes via
/// <c>[data-theme="dark"]</c> on <c>html</c>, neutral palette sampled from
/// the live ORBIT site.  The user's theme choice is persisted under the
/// same <c>prism.theme</c> localStorage key the SPA uses.
///
/// v0.1.35: the header now carries the full PRISM logo. The image is
/// injected as a base64 <c>data:</c> URL by <see cref="AgentWebUi"/> at
/// startup (one read from <c>Assets/prism-logo.png</c>, cached for the
/// process lifetime), so the page stays a single HTTP response with no
/// extra asset routes.
/// </summary>
internal static class IndexHtml
{
    /// <summary>
    /// Placeholder substituted by <see cref="AgentWebUi"/> at request time
    /// with the base64-encoded contents of <c>Assets/prism-logo.png</c>.
    /// Falls back to an empty string when the asset cannot be loaded, in
    /// which case the CSS hides the broken image with <c>img[src=""]</c>.
    /// </summary>
    public const string LogoToken = "{{PRISM_LOGO_B64}}";

    public const string Template = """
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PRISM Agent</title>
<script>
  (function () {
    var saved = localStorage.getItem('prism.theme') || 'system';
    var dark = saved === 'dark' ||
      (saved === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  })();
</script>
<style>
  /* -- ORBIT/PRISM design tokens (mirrors web/src/shared/designSystem.css) -- */
  :root {
    color-scheme: light;
    --orbit-primary:        #e06238;
    --orbit-primary-hover:  #c4542d;
    --orbit-primary-fade:   #fde9df;
    --color-bg:             #ffffff;
    --color-bg-elevated:    #fafafa;
    --color-bg-input:       #ffffff;
    --color-bg-hover:       #f3f4f6;
    --color-border:         #e5e7eb;
    --color-border-strong:  #d1d5db;
    --color-text:           #111827;
    --color-text-muted:     #4b5563;
    --color-text-subtle:    #9ca3af;
    --color-success:        #15803d;
    --color-success-bg:     #dcfce7;
    --color-warn:           #b45309;
    --color-warn-bg:        #fef3c7;
    --color-error:          #b91c1c;
    --color-error-bg:       #fee2e2;
    --color-info:           #1d4ed8;
    --color-info-bg:        #dbeafe;
    --radius-sm: 4px;
    --radius:    8px;
    --radius-lg: 12px;
    --shadow-1: 0 1px 2px 0 rgba(0,0,0,.05);
    --shadow-2: 0 4px 12px -2px rgba(0,0,0,.08), 0 2px 4px -1px rgba(0,0,0,.04);
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  }
  [data-theme="dark"] {
    color-scheme: dark;
    --orbit-primary-hover:  #c94f26;
    --orbit-primary-fade:   #382d29;
    --color-bg:             #101012;
    --color-bg-elevated:    #15161c;
    --color-bg-input:       #191a22;
    --color-bg-hover:       #1f2129;
    --color-border:         #332b28;
    --color-border-strong:  #3e312d;
    --color-text:           #ffffff;
    --color-text-muted:     #b0b1b5;
    --color-text-subtle:    #7e7f82;
    --color-success:        #34d399;
    --color-success-bg:     #072c1f;
    --color-warn:           #fbbf24;
    --color-warn-bg:        #302303;
    --color-error:          #f87171;
    --color-error-bg:       #300303;
    --color-info:           #93c5fd;
    --color-info-bg:        #1e2a3d;
    --shadow-1: 0 1px 2px 0 rgba(0,0,0,.4);
    --shadow-2: 0 4px 12px -2px rgba(0,0,0,.55), 0 2px 4px -1px rgba(0,0,0,.4);
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--color-bg);
    color: var(--color-text);
    font: 14px/1.5 var(--font-sans);
  }

  a { color: var(--orbit-primary); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Header */
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 24px;
    background: var(--color-bg-elevated);
    border-bottom: 1px solid var(--color-border);
    position: sticky; top: 0; z-index: 5;
  }
  header .title {
    display: flex; align-items: center; gap: 12px;
    font-size: 16px; font-weight: 600; letter-spacing: .2px; margin: 0;
  }
  header .title .logo {
    width: 32px; height: 32px;
    object-fit: contain;
    display: inline-block;
  }
  /* Hide the logo image when the data: URL substitution failed (the
     template fell back to an empty src) so the page does not show a
     broken-image glyph. */
  header .title .logo[src=""] { display: none; }
  header .title .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--color-warn);
    box-shadow: 0 0 8px currentColor;
  }
  header.connected .dot { background: var(--color-success); }
  header.paused    .dot { background: var(--color-text-subtle); box-shadow: none; }
  header.offline   .dot { background: var(--color-error); }

  header .meta { display: flex; gap: 14px; align-items: center; color: var(--color-text-muted); font-size: 12px; }
  header .meta code { font-family: var(--font-mono); font-size: 12px; background: var(--color-bg-input); padding: 2px 6px; border-radius: 4px; }

  /* Layout */
  main { max-width: 1080px; margin: 0 auto; padding: 24px 24px 80px; }

  .card {
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-1);
    margin-bottom: 18px;
    overflow: hidden;
  }
  .card > h2 {
    margin: 0; padding: 12px 18px;
    font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .12em;
    color: var(--color-text-muted);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
  }
  .card .body { padding: 18px; }

  /* Stats grid */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 12px; }
  .stat {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .stat .label {
    color: var(--color-text-muted);
    font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
    margin-bottom: 6px;
  }
  .stat .value { font-size: 18px; font-weight: 600; }

  /* Forms */
  .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap: 14px; }
  label.field { display: block; }
  label.field > span {
    display: block;
    color: var(--color-text-muted); font-size: 11px;
    text-transform: uppercase; letter-spacing: .08em;
    margin-bottom: 6px;
  }

  input, select, textarea {
    width: 100%;
    background: var(--color-bg-input);
    color: var(--color-text);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius);
    padding: 7px 10px;
    font: 13px/1.4 var(--font-sans);
  }
  input:focus, select:focus { outline: none; border-color: var(--orbit-primary); box-shadow: 0 0 0 3px var(--orbit-primary-fade); }

  /* Toggle group */
  .toggle-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .toggle {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--color-bg);
    padding: 7px 12px;
    border-radius: var(--radius);
    cursor: pointer;
    border: 1px solid var(--color-border);
    user-select: none;
    font-size: 13px;
  }
  .toggle input { width: auto; accent-color: var(--orbit-primary); }
  .toggle.checked {
    border-color: var(--orbit-primary);
    background: var(--orbit-primary-fade);
    color: var(--orbit-primary);
  }
  [data-theme="dark"] .toggle.checked { color: var(--color-text); }

  /* Buttons */
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  button {
    appearance: none;
    border: 1px solid var(--color-border-strong);
    background: var(--color-bg-elevated);
    color: var(--color-text);
    border-radius: var(--radius);
    padding: 7px 14px;
    font: 500 13px var(--font-sans);
    cursor: pointer;
  }
  button:hover { border-color: var(--orbit-primary); }
  button.primary {
    background: var(--orbit-primary); border-color: var(--orbit-primary); color: #fff;
  }
  button.primary:hover { background: var(--orbit-primary-hover); border-color: var(--orbit-primary-hover); }
  button.danger {
    background: var(--color-error-bg); border-color: var(--color-error); color: var(--color-error);
  }
  button.danger:hover { background: var(--color-error); color: #fff; }
  button:disabled { opacity: .45; cursor: not-allowed; }

  button.icon-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-text-muted);
    padding: 6px;
    width: 32px; height: 32px;
    display: inline-flex; align-items: center; justify-content: center;
  }
  button.icon-btn:hover { background: var(--color-bg-hover); border-color: var(--color-border); color: var(--color-text); }

  /* Pills */
  .pill {
    display: inline-flex; align-items: center;
    padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .pill.online { background: var(--color-success-bg); color: var(--color-success); }
  .pill.offline { background: var(--color-error-bg); color: var(--color-error); }
  .pill.paused { background: var(--color-warn-bg);  color: var(--color-warn); }

  /* Formats list */
  .formats { display: flex; gap: 6px; flex-wrap: wrap; }
  .formats code {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    padding: 3px 8px; border-radius: var(--radius-sm);
    font: 12px var(--font-mono); color: var(--color-text);
  }

  /* Logs */
  pre.logs {
    background: var(--color-bg-input);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 12px;
    height: 360px; overflow: auto; margin: 0;
    font: 12px/1.5 var(--font-mono);
  }

  /* Hint / box */
  .hint { color: var(--color-text-muted); font-size: 12px; margin-top: 8px; }
  .info-box {
    background: var(--color-info-bg); color: var(--color-info);
    padding: 8px 12px; border-radius: var(--radius);
    font-size: 13px; margin-bottom: 12px;
  }
  .warn-box {
    background: var(--color-warn-bg); color: var(--color-warn);
    padding: 8px 12px; border-radius: var(--radius);
    font-size: 13px; margin-bottom: 12px;
  }

  /* Toast */
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 12px 18px;
    box-shadow: var(--shadow-2);
    color: var(--color-text);
    font-size: 13px;
    transform: translateY(20px); opacity: 0; pointer-events: none;
    transition: transform .2s ease, opacity .2s ease;
    z-index: 50;
    max-width: 360px;
  }
  .toast.show { transform: translateY(0); opacity: 1; }
  .toast.error { border-color: var(--color-error); color: var(--color-error); }
  .toast.warn  { border-color: var(--color-warn);  color: var(--color-warn); }
  .toast.success { border-color: var(--color-success); color: var(--color-success); }
</style>
</head>
<body>

<header id="header" class="offline">
  <h1 class="title">
    <img class="logo" src="{{PRISM_LOGO_B64}}" alt="PRISM" />
    <span class="dot"></span>
    PRISM Agent
  </h1>
  <div class="meta">
    <span><code id="version">—</code></span>
    <span><code id="machineId">—</code></span>
    <button class="icon-btn" id="themeToggle" title="Toggle theme" aria-label="Toggle theme">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"></path>
      </svg>
    </button>
  </div>
</header>

<main>

  <section class="card">
    <h2>Status</h2>
    <div class="body">
      <div class="grid">
        <div class="stat"><div class="label">Connection</div><div class="value" id="connState">—</div></div>
        <div class="stat"><div class="label">Watcher</div><div class="value" id="watcherState">—</div></div>
        <div class="stat"><div class="label">Slots busy</div><div class="value" id="slotsBusy">—</div></div>
        <div class="stat"><div class="label">Slots total</div><div class="value" id="slotsTotal">—</div></div>
      </div>
      <div class="actions">
        <button id="btnPause" class="danger">Pause watcher</button>
        <button id="btnResume" class="primary">Resume watcher</button>
        <button id="btnRefresh">Refresh</button>
      </div>
      <p class="hint">
        Pausing the watcher disconnects this agent from PRISM so new
        conversion / layer / receive jobs route to other workstations.
        Slots already running finish normally.
      </p>
    </div>
  </section>

  <section class="card">
    <h2>Connection</h2>
    <div class="body">
      <div class="row">
        <label class="field">
          <span>PRISM server URL</span>
          <input type="url" id="prismUrl" placeholder="wss://prism.rebus.industries/ws/agent" />
        </label>
        <label class="field">
          <span>Node name</span>
          <input type="text" id="nodeName" />
        </label>
      </div>
      <p class="hint">Restart the agent after changing the server URL.</p>
    </div>
  </section>

  <section class="card">
    <h2>Capacity</h2>
    <div class="body">
      <div class="row">
        <label class="field">
          <span>Slots (1–8)</span>
          <input type="number" id="slots" min="1" max="8" />
        </label>
        <div>
          <span class="hint" style="display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em;font-size:11px;">Roles</span>
          <div class="toggle-row" id="roles"></div>
        </div>
      </div>
      <p class="hint">
        Slots set parallelism. Rhino is single-instance so jobs serialise on
        the host, but extra slots let the agent accept the next assignment
        while one is finishing its upload phase.
      </p>
    </div>
  </section>

  <section class="card">
    <h2>Rhino &amp; logs</h2>
    <div class="body">
      <div class="row">
        <label class="field">
          <span>Rhino version</span>
          <select id="rhinoVersion">
            <option value="auto">auto (highest installed)</option>
            <option value="8">Rhino 8</option>
            <option value="9">Rhino 9 (when released)</option>
          </select>
        </label>
        <label class="field">
          <span>Log directory</span>
          <input type="text" id="logDir" />
        </label>
      </div>
      <p class="hint">Restart the agent after changing the Rhino version.</p>
    </div>
  </section>

  <section class="card">
    <h2>Web UI access</h2>
    <div class="body">
      <div class="row">
        <label class="field">
          <span>Port</span>
          <input type="number" id="webUiPort" min="0" max="65535" />
        </label>
        <div>
          <span class="hint" style="display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em;font-size:11px;">Reachable from</span>
          <div class="toggle-row">
            <label class="toggle" id="bindAllLabel">
              <input type="checkbox" id="webUiBindAll" />
              <span>Allow LAN access</span>
            </label>
          </div>
        </div>
      </div>
      <p class="hint">
        With LAN access on, this page is reachable from any other machine on
        the trusted network at <code id="lanUrl">—</code>. The installer
        pre-registers a URL ACL for the configured port so the agent does
        not need to be elevated. Restart required after changing port or
        binding.
      </p>
    </div>
  </section>

  <section class="card" id="visualiserCard" hidden>
    <h2>Visualiser</h2>
    <div class="body">
      <div class="warn-box">
        Phase A scaffold — the agent persists these settings and advertises the
        role to PRISM, but the Unreal orchestrator binary lands in a later release.
        Until then, <code>startVisualisation</code> envelopes are acked with
        <code>accepted: false</code>.
      </div>
      <div class="row">
        <label class="field">
          <span>Unreal Engine root</span>
          <input type="text" id="unrealEngineRoot" placeholder="C:\Program Files\Epic Games\UE_5.7\" />
        </label>
      </div>
      <div class="row">
        <label class="field">
          <span>Portal URL</span>
          <input type="url" id="portalUrl" placeholder="https://app.rebus.industries" />
        </label>
        <label class="field">
          <span>Portal API key (REBUS)</span>
          <input type="password" id="rebusApiKey" autocomplete="off" placeholder="not set" />
        </label>
      </div>
      <p class="hint">
        The <strong>Portal URL</strong> and <strong>API key</strong> are passed
        to the Unreal plug-ins on the next visualiser run
        (<code>-PortalUrl</code> / <code>-RebusApiKey</code>). The API key is
        write-only: it is stored on this workstation and forwarded to Unreal,
        but is never shown here again — the field shows
        <em>"key set"</em> once saved. Leave it blank to keep the existing key;
        type a new value to replace it.
      </p>
      <div class="row">
        <label class="field">
          <span>Max concurrent sessions (1–4)</span>
          <input type="number" id="visualiserMaxConcurrent" min="1" max="4" />
        </label>
        <div>
          <span class="hint" style="display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em;font-size:11px;">GPU check</span>
          <div class="toggle-row">
            <label class="toggle" id="visualiserGpuCheckLabel">
              <input type="checkbox" id="visualiserGpuCheck" />
              <span>Require discrete GPU at startup</span>
            </label>
          </div>
        </div>
      </div>
      <div class="row">
        <div>
          <span class="hint" style="display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em;font-size:11px;">Debug window</span>
          <div class="toggle-row">
            <label class="toggle" id="visualiserDebugWindowLabel">
              <input type="checkbox" id="visualiserDebugWindow" />
              <span>Show visible UE window (debug)</span>
            </label>
          </div>
        </div>
      </div>
      <div class="row">
        <div>
          <span class="hint" style="display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em;font-size:11px;">Full editor</span>
          <div class="toggle-row">
            <label class="toggle" id="visualiserFullEditorLabel">
              <input type="checkbox" id="visualiserFullEditor" />
              <span>Open full Unreal Editor (control on workstation) + browser stream</span>
            </label>
          </div>
        </div>
      </div>
      <div class="row">
        <div>
          <span class="hint" style="display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em;font-size:11px;">Template project</span>
          <input type="text" id="visualiserTemplateProjectPath" style="width:100%;box-sizing:border-box;"
                 placeholder="C:\PRISM\Templates\MINIMAL_CUBE" />
          <span class="hint" style="display:block;margin-top:4px;">Full-editor baseline project opened &amp; auto-streamed. Default: minimal cube. Use C:\PRISM\Templates\REBUS_TEMPLATE for the full template.</span>
        </div>
      </div>
      <div class="row">
        <label class="field">
          <span>Template root</span>
          <input type="text" id="visualiserTemplateRoot" placeholder="C:\PRISM\Templates" />
        </label>
        <label class="field">
          <span>Template repo</span>
          <input type="text" id="unrealTemplateRepo" placeholder="REBUS-ORBIT/orbit-ue-template" />
        </label>
      </div>
      <div class="row">
        <label class="field">
          <span>Connector repo</span>
          <input type="text" id="orbitConnectorRepo" placeholder="REBUS-ORBIT/orbit-connectors" />
        </label>
      </div>
      <div class="row">
        <label class="toggle" id="visualiserPullConnectorLabel" style="align-self:center;">
          <input type="checkbox" id="visualiserPullConnector" />
          <span>Merge OrbitConnector plug-in into pulled project</span>
        </label>
      </div>
      <div class="row">
        <label class="toggle" id="visualiserCompileProjectLabel" style="align-self:center;">
          <input type="checkbox" id="visualiserCompileProject" />
          <span>Compile project after pull (UnrealBuildTool — needed for C++ plug-ins)</span>
        </label>
      </div>
      <div class="row">
        <div>
          <span class="hint" style="display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em;font-size:11px;">Installed UE template</span>
          <div id="installedTemplate" style="font-weight:600;">unknown</div>
          <span class="hint" style="display:block;margin-top:4px;">
            The template release currently installed at <em>Template project</em> above
            (read from its <code>.prism-template.json</code> marker). This is what the
            agent reports to PRISM and persists across restarts — independent of the
            last pull below.
          </span>
        </div>
      </div>
      <div class="row">
        <div>
          <span class="hint" style="display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em;font-size:11px;">Pull UE template</span>
          <div class="actions" style="margin-top:0;align-items:center;">
            <select id="templateRelease" style="min-width:240px;">
              <option value="">Latest release</option>
            </select>
            <button id="btnReleasesRefresh" class="btn-small" title="Refresh the release list from the template repo">↻</button>
            <button id="btnPullTemplate" class="primary">Pull selected version</button>
            <span id="templatePullStatus" class="hint" style="align-self:center;"></span>
          </div>
          <span class="hint" style="display:block;margin-top:6px;">
            Pick a published version of the template repo above (default
            <em>Latest release</em>) and pull it into the <em>Template root</em>. When
            <em>Merge OrbitConnector plug-in</em> is on, the latest (or pinned)
            <em>OrbitConnector.UE5</em> build is merged into the pulled project's
            <code>Plugins\</code> so the connector-driven import works. On success the
            <em>Template project</em> above is repointed at the pulled project, ready
            for the next run. Save any path / repo / tag edits first.
          </span>
        </div>
      </div>
      <p class="hint">
        On agent start, if the Visualiser role is enabled but the Unreal
        Engine root above is missing, a structured <code>WARN</code> is
        sent to PRISM so the admin dashboard surfaces the misconfiguration.
        Other roles keep running normally.
      </p>
      <p class="hint">
        <strong>Debug window</strong> makes the next visualiser run open a
        visible Unreal Engine window (windowed, not headless) so you can watch
        the scene, viewport and logs on this workstation. Pixel Streaming to
        the browser keeps working. Applies to the next run — no restart needed.
        The window is only visible when the agent runs in your interactive
        desktop session (not as a session-0 Windows service).
      </p>
      <p class="hint">
        <strong>Full editor</strong> opens the full Unreal Editor GUI (World
        Outliner, Details, Content Browser, viewport gizmos) on the imported
        map AND Pixel-Streams the level-editor viewport to the browser viewer
        at the same time — you drive Unreal on this workstation while remote
        viewers watch the streamed viewport. It <strong>supersedes</strong> the
        debug window when both are on. Applies to the next run; the editor only
        appears in your interactive desktop session (not a session-0 service).
        If auto-start doesn't engage, click <em>Stream Level Editor</em> on the
        Pixel Streaming toolbar in the editor.
      </p>
    </div>
  </section>

  <section class="card">
    <h2>Supported formats</h2>
    <div class="body">
      <div class="formats" id="supportedFormats"></div>
      <p class="hint">
        Extensions advertised in the agent's <code>hello</code> message.
        Formats outside this set get pre-converted upstream by
        <code>prism-assimp</code> before being routed here.
      </p>
    </div>
  </section>

  <section class="card">
    <h2>Save</h2>
    <div class="body">
      <div class="actions">
        <button id="btnSave" class="primary">Save settings</button>
        <button id="btnReload">Discard changes</button>
      </div>
      <p class="hint">
        Live-applied: node name, slots, roles, log dir.
        Restart-required: server URL, Rhino version, web UI port, LAN binding.
      </p>
    </div>
  </section>

  <section class="card">
    <h2>Agent lifecycle</h2>
    <div class="body">
      <div class="actions">
        <button id="btnUpdate" class="primary">Check for updates</button>
        <button id="btnRestart" class="danger">Restart agent</button>
      </div>
      <p class="hint">
        <strong>Check for updates</strong> polls the
        <code>REBUS-ORBIT/prism-agent</code> GitHub release feed; if a newer
        version is available the agent downloads it and self-restarts (this
        page will go offline for a few seconds while the new binary takes
        over).
        <strong>Restart</strong> cleanly exits the current process — the
        Windows Scheduled Task and a self-spawned helper script relaunch
        the agent within ~1 minute.
      </p>
    </div>
  </section>

  <section class="card">
    <h2>Logs (last 500)</h2>
    <div class="body">
      <pre id="logs" class="logs">loading…</pre>
      <div class="actions">
        <button id="btnLogs">Refresh logs</button>
      </div>
    </div>
  </section>

</main>

<div class="toast" id="toast"></div>

<script>
  const $ = (id) => document.getElementById(id);

  let state = null;
  let dirty = false;
  // Repo slug the release dropdown was last populated for (re-fetched when it changes).
  let releasesLoadedForRepo = null;

  // ---- Theme toggle ----
  function applyTheme(theme) {
    const dark = theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
  $('themeToggle').addEventListener('click', () => {
    const current = localStorage.getItem('prism.theme') || 'system';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('prism.theme', next);
    applyTheme(next);
  });

  // ---- API helpers ----
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
    toast._t = setTimeout(() => { el.className = 'toast'; }, 4000);
  }

  // ---- State rendering ----
  function applyState(s) {
    state = s;

    $('version').textContent = `v${s.agent.version}`;
    $('machineId').textContent = s.agent.machineId.slice(0, 8) + '…';

    const header = $('header');
    header.classList.remove('connected', 'paused', 'offline');
    if (s.agent.paused)         header.classList.add('paused');
    else if (s.agent.connected) header.classList.add('connected');
    else                        header.classList.add('offline');

    $('connState').innerHTML = s.agent.connected
      ? '<span class="pill online">Connected</span>'
      : '<span class="pill offline">Disconnected</span>';
    $('watcherState').innerHTML = s.agent.paused
      ? '<span class="pill paused">Paused</span>'
      : '<span class="pill online">Running</span>';
    $('slotsBusy').textContent = s.agent.slotsBusy;
    $('slotsTotal').textContent = s.config.slots;

    $('btnPause').disabled  = s.agent.paused;
    $('btnResume').disabled = !s.agent.paused;

    if (!dirty) {
      $('prismUrl').value     = s.config.prismUrl;
      $('nodeName').value     = s.config.nodeName;
      $('slots').value        = s.config.slots;
      $('rhinoVersion').value = s.config.rhinoVersion;
      $('logDir').value       = s.config.logDir;
      $('webUiPort').value    = s.config.webUiPort;
      const bindAll = !!s.config.webUiBindAll;
      $('webUiBindAll').checked = bindAll;
      $('bindAllLabel').classList.toggle('checked', bindAll);
      renderRoles(s.availableRoles, new Set(s.config.roles));

      $('unrealEngineRoot').value       = s.config.unrealEngineRoot       ?? '';
      $('visualiserMaxConcurrent').value = s.config.visualiserMaxConcurrent ?? 1;
      const gpu = !!s.config.visualiserGpuCheck;
      $('visualiserGpuCheck').checked = gpu;
      $('visualiserGpuCheckLabel').classList.toggle('checked', gpu);
      const dbgWin = !!s.config.visualiserDebugWindow;
      $('visualiserDebugWindow').checked = dbgWin;
      $('visualiserDebugWindowLabel').classList.toggle('checked', dbgWin);
      const fullEd = !!s.config.visualiserFullEditor;
      $('visualiserFullEditor').checked = fullEd;
      $('visualiserFullEditorLabel').classList.toggle('checked', fullEd);
      if (document.activeElement !== $('visualiserTemplateProjectPath'))
        $('visualiserTemplateProjectPath').value = s.config.visualiserTemplateProjectPath || '';
      if (document.activeElement !== $('visualiserTemplateRoot'))
        $('visualiserTemplateRoot').value = s.config.visualiserTemplateRoot || '';
      if (document.activeElement !== $('unrealTemplateRepo'))
        $('unrealTemplateRepo').value = s.config.unrealTemplateRepo || '';
      if (document.activeElement !== $('orbitConnectorRepo'))
        $('orbitConnectorRepo').value = s.config.orbitConnectorRepo || '';
      const pullConn = s.config.visualiserPullConnector !== false;
      $('visualiserPullConnector').checked = pullConn;
      $('visualiserPullConnectorLabel').classList.toggle('checked', pullConn);
      const compileProj = s.config.visualiserCompileProject !== false;
      $('visualiserCompileProject').checked = compileProj;
      $('visualiserCompileProjectLabel').classList.toggle('checked', compileProj);

      // Portal URL is echoed normally. The API key is never returned by the
      // server — only a rebusApiKeySet boolean — so we leave the password
      // field blank and use its placeholder to show "key set" / "not set".
      // Skip overwriting the URL if the operator is mid-edit.
      if (document.activeElement !== $('portalUrl'))
        $('portalUrl').value = s.config.portalUrl || '';
      const keyInput = $('rebusApiKey');
      // Don't clobber a value the operator is currently typing.
      if (document.activeElement !== keyInput && !keyInput.value) {
        keyInput.placeholder = s.config.rebusApiKeySet ? 'key set — leave blank to keep' : 'not set';
      }
    }

    renderTemplatePull(s.templatePull);
    renderInstalledTemplate(s.installedTemplate);

    const visualiserEnabled = (s.config.roles || []).includes('visualiser');
    $('visualiserCard').hidden = !visualiserEnabled;
    // Lazily load the template release list the first time the visualiser
    // card becomes visible (and whenever the repo changes via Save).
    if (visualiserEnabled && s.config.unrealTemplateRepo !== releasesLoadedForRepo) {
      releasesLoadedForRepo = s.config.unrealTemplateRepo;
      loadReleases();
    }

    // LAN URL hint -- show the host:port a remote operator would type.
    const host = location.hostname && location.hostname !== 'localhost'
      ? location.hostname
      : '<workstation-ip>';
    $('lanUrl').textContent = `http://${host}:${s.config.webUiPort}/`;

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
        if (role === 'visualiser') $('visualiserCard').hidden = !cb.checked;
      });
      const label = document.createElement('span');
      label.textContent = role;
      wrap.appendChild(cb);
      wrap.appendChild(label);
      host.appendChild(wrap);
    }
  }

  function markDirty() {
    dirty = true;
    $('btnSave').textContent = 'Save settings *';
  }
  function clearDirty() {
    dirty = false;
    $('btnSave').textContent = 'Save settings';
  }

  function collectUpdate() {
    const roles = Array.from(document.querySelectorAll('#roles input:checked'))
      .map((el) => el.dataset.role);
    const update = {
      prismUrl:     $('prismUrl').value.trim(),
      nodeName:     $('nodeName').value.trim(),
      slots:        Number($('slots').value),
      roles,
      rhinoVersion: $('rhinoVersion').value,
      logDir:       $('logDir').value.trim(),
      webUiPort:    Number($('webUiPort').value),
      webUiBindAll: $('webUiBindAll').checked,
      unrealEngineRoot:        $('unrealEngineRoot').value.trim(),
      visualiserMaxConcurrent: Number($('visualiserMaxConcurrent').value),
      visualiserGpuCheck:      $('visualiserGpuCheck').checked,
      visualiserDebugWindow:   $('visualiserDebugWindow').checked,
      visualiserFullEditor:    $('visualiserFullEditor').checked,
      visualiserTemplateProjectPath: $('visualiserTemplateProjectPath').value.trim(),
      visualiserTemplateRoot:  $('visualiserTemplateRoot').value.trim(),
      unrealTemplateRepo:      $('unrealTemplateRepo').value.trim(),
      orbitConnectorRepo:      $('orbitConnectorRepo').value.trim(),
      visualiserPullConnector: $('visualiserPullConnector').checked,
      visualiserCompileProject: $('visualiserCompileProject').checked,
      // Portal URL is not secret — always sent.
      portalUrl:               $('portalUrl').value.trim(),
    };
    // Portal API key (SECRET): only send it when the operator actually typed
    // one. Omitting it (or sending blank) leaves the stored key unchanged
    // server-side, so an unrelated save never wipes the key.
    const rebusApiKey = $('rebusApiKey').value;
    if (rebusApiKey && rebusApiKey.trim().length > 0) {
      update.rebusApiKey = rebusApiKey.trim();
    }
    return update;
  }

  // ---- Template release picker ----
  async function loadReleases() {
    const sel = $('templateRelease');
    const prev = sel.value;
    try {
      const r = await api('/api/visualiser/template/releases');
      const releases = (r && r.releases) || [];
      sel.innerHTML = '';
      const latest = document.createElement('option');
      latest.value = '';
      latest.textContent = 'Latest release';
      sel.appendChild(latest);
      for (const rel of releases) {
        const o = document.createElement('option');
        o.value = rel.tag;
        const date = rel.publishedAt ? ' · ' + new Date(rel.publishedAt).toLocaleDateString() : '';
        const pre = rel.prerelease ? ' (pre)' : '';
        o.textContent = (rel.name && rel.name !== rel.tag ? rel.name + ' — ' : '') + rel.tag + pre + date;
        if (!rel.hasArchive) { o.disabled = true; o.textContent += ' · no archive'; }
        sel.appendChild(o);
      }
      // Preserve the operator's selection across refreshes when still present.
      if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
    } catch (err) {
      // Leave the lone "Latest release" option in place; surface softly.
      toast('Could not list template releases: ' + err.message, 'warn');
    }
  }

  function renderInstalledTemplate(it) {
    const el = $('installedTemplate');
    if (!el) return;
    const tag = it && it.templateTag;
    if (!tag) {
      el.textContent = 'unknown';
      el.style.color = 'var(--color-text-subtle)';
      return;
    }
    el.style.color = 'var(--color-text)';
    const conn = it && it.connectorTag;
    el.textContent = conn ? `${tag}  ·  connector ${conn}` : tag;
  }

  function renderTemplatePull(tp) {
    const el = $('templatePullStatus');
    const btn = $('btnPullTemplate');
    if (!tp) { el.textContent = ''; return; }
    const running = tp.state === 'running' || tp.inProgress;
    btn.disabled = running;
    if (running) {
      btn.textContent = 'Pulling…';
      el.style.color = 'var(--color-text-muted)';
      el.textContent = tp.message || 'pulling…';
    } else {
      btn.textContent = 'Pull selected version';
      if (tp.state === 'success') {
        el.style.color = 'var(--color-success)';
        el.textContent = tp.message || 'done';
      } else if (tp.state === 'error') {
        el.style.color = 'var(--color-error)';
        el.textContent = 'failed: ' + (tp.message || 'unknown error');
      } else {
        el.style.color = 'var(--color-text-muted)';
        el.textContent = '';
      }
    }
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
      toast('Watcher resumed', 'success');
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
      // Clear the write-only API key field so it isn't resent on the next
      // save and the placeholder can reflect the new "key set" state.
      $('rebusApiKey').value = '';
      applyState(r.state);
      toast(r.restartRequired
        ? 'Saved. Restart the agent to apply server URL / Rhino / web UI changes.'
        : 'Saved.',
        r.restartRequired ? 'warn' : 'success');
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
  });

  $('btnUpdate').addEventListener('click', async () => {
    const btn = $('btnUpdate');
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const r = await api('/api/agent/update', { method: 'POST', body: '{}' });
      if (r.downloading) {
        toast(`Update ${r.tag ?? ''} downloading — the agent will restart automatically.`, 'success');
      } else {
        toast(r.message || `Already on the latest version (${r.version || ''}).`, 'success');
      }
    } catch (err) {
      toast('Update check failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  $('btnReleasesRefresh').addEventListener('click', () => loadReleases());

  $('btnPullTemplate').addEventListener('click', async () => {
    const btn = $('btnPullTemplate');
    if (dirty && !confirm('You have unsaved settings changes. Pull using the last SAVED template root / repo / connector settings?\n\nClick Cancel to save first.')) return;
    const tag = $('templateRelease').value.trim();
    btn.disabled = true;
    btn.textContent = 'Pulling…';
    try {
      const r = await api('/api/visualiser/template/pull', { method: 'POST', body: JSON.stringify(tag ? { tag } : {}) });
      if (r.state) renderTemplatePull(r.state.templatePull);
      const label = tag ? `version ${tag}` : 'latest UE template';
      toast(r.alreadyRunning ? 'A template pull is already running.' : `Pulling ${label} — watch the status line.`, r.alreadyRunning ? 'warn' : 'success');
    } catch (err) {
      toast('Pull failed: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Pull selected version';
    }
  });

  $('btnRestart').addEventListener('click', async () => {
    if (!confirm('Restart the PRISM agent now?\n\nIn-flight jobs in this process will be cancelled. The agent will come back online within ~1 minute.')) return;
    const btn = $('btnRestart');
    btn.disabled = true;
    btn.textContent = 'Restarting…';
    try {
      await api('/api/agent/restart', { method: 'POST', body: '{}' });
      toast('Restart scheduled — this page will reconnect when the agent comes back.', 'warn');
    } catch (err) {
      // A successful restart often races the fetch — the agent exits
      // before the response body lands, so the browser sees a network
      // error. Treat that as success and keep watching.
      toast('Restart issued — waiting for agent to come back online.', 'warn');
    }
  });

  for (const id of [
    'prismUrl','nodeName','slots','rhinoVersion','logDir','webUiPort',
    'unrealEngineRoot','visualiserMaxConcurrent',
    'visualiserTemplateRoot','unrealTemplateRepo',
    'orbitConnectorRepo','portalUrl','rebusApiKey',
  ]) {
    $(id).addEventListener('input', markDirty);
  }
  $('visualiserPullConnector').addEventListener('change', () => {
    $('visualiserPullConnectorLabel').classList.toggle('checked', $('visualiserPullConnector').checked);
    markDirty();
  });
  $('visualiserCompileProject').addEventListener('change', () => {
    $('visualiserCompileProjectLabel').classList.toggle('checked', $('visualiserCompileProject').checked);
    markDirty();
  });
  $('webUiBindAll').addEventListener('change', () => {
    $('bindAllLabel').classList.toggle('checked', $('webUiBindAll').checked);
    markDirty();
  });
  $('visualiserGpuCheck').addEventListener('change', () => {
    $('visualiserGpuCheckLabel').classList.toggle('checked', $('visualiserGpuCheck').checked);
    markDirty();
  });
  $('visualiserFullEditor').addEventListener('change', () => {
    $('visualiserFullEditorLabel').classList.toggle('checked', $('visualiserFullEditor').checked);
    markDirty();
  });
  $('visualiserDebugWindow').addEventListener('change', () => {
    $('visualiserDebugWindowLabel').classList.toggle('checked', $('visualiserDebugWindow').checked);
    markDirty();
  });
  $('visualiserTemplateProjectPath').addEventListener('input', () => markDirty());

  refresh().then(refreshLogs);
  setInterval(refresh, 4000);
</script>
</body>
</html>
""";
}
