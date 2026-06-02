/**
 * Visualiser control-channel client (multi-viewer single-controller lock).
 *
 * Opens `/ws/visualiser/:runId/control?token=<jwt>` — a channel separate
 * from the Pixel Streaming signalling stream so PRISM control messages
 * never pollute the opaque PS sub-protocol. Surfaces the authoritative
 * controller state pushed by the server and exposes take/release.
 *
 * The control URL is derived from the signalling URL (…/signalling →
 * …/control). The token provider must mint a JWT with the SAME stable
 * viewerId used by the player so the seat + lock line up.
 */
import { onUnmounted, ref } from 'vue';

export interface VisualiserControlOptions {
  /** Public signalling URL (wss://…/ws/visualiser/<runId>/signalling). */
  signallingUrl: string;
  /** Returns a fresh signalling JWT (same viewerId as the player). */
  tokenProvider: () => Promise<string>;
}

export function controlUrlFromSignalling(signallingUrl: string): string {
  return signallingUrl.replace(/\/signalling(\b|$)/, '/control');
}

export function useVisualiserControl(opts: VisualiserControlOptions) {
  const controllerViewerId = ref<string | null>(null);
  const youAreController = ref(false);
  const canControl = ref(false);
  const connected = ref(false);
  let ws: WebSocket | null = null;
  let closedByUs = false;

  async function connect(): Promise<void> {
    closedByUs = false;
    const token = await opts.tokenProvider();
    const base = controlUrlFromSignalling(opts.signallingUrl);
    const sep = base.includes('?') ? '&' : '?';
    ws = new WebSocket(`${base}${sep}token=${encodeURIComponent(token)}`);
    ws.onopen = () => { connected.value = true; };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (msg && msg.type === 'controller') {
          controllerViewerId.value = msg.controllerViewerId ?? null;
          youAreController.value = Boolean(msg.youAreController);
          canControl.value = Boolean(msg.canControl);
        }
      } catch { /* ignore non-JSON */ }
    };
    ws.onclose = () => {
      connected.value = false;
      youAreController.value = false;
      if (!closedByUs) setTimeout(() => { void connect().catch(() => {}); }, 2000);
    };
    ws.onerror = () => { /* close handler retries */ };
  }

  function take(): void { try { ws?.send(JSON.stringify({ type: 'take' })); } catch { /* ignore */ } }
  function release(): void { try { ws?.send(JSON.stringify({ type: 'release' })); } catch { /* ignore */ } }

  function disconnect(): void {
    closedByUs = true;
    try { ws?.close(); } catch { /* ignore */ }
    ws = null;
  }

  onUnmounted(disconnect);

  return { connect, disconnect, take, release, controllerViewerId, youAreController, canControl, connected };
}
