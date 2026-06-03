/**
 * Unit tests for the viewer-aware idle reaper wiring.
 *
 * These exercise the CORRECT activity signal — the count of connected viewer
 * signalling sockets — without touching the DB or real sockets:
 *   1. signallingProxyRegistry emits accurate viewer-count changes on
 *      add/remove (the signal the reaper consumes).
 *   2. The reaper arms a countdown only when viewers hit zero, and cancels it
 *      the instant a viewer (re)connects — so an actively-watched run is never
 *      reaped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  signallingProxyRegistry,
  type BrowserConn,
} from '../src/ws/signallingProxyRegistry.js';
import { visualiserIdleReaper } from '../src/visualiser/idleReaper.js';

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  send() { /* noop */ }
  close() { this.readyState = 3; }
}

function conn(runId: string, viewerId: string, socket: FakeSocket): BrowserConn {
  return { socket: socket as unknown as WebSocket, agentSessionId: `agent-${runId}`, runId, viewerId, tier: 'control' };
}

afterEach(() => {
  // Detach any listener so tests don't leak into one another.
  signallingProxyRegistry.setViewerCountListener(null);
});

describe('signallingProxyRegistry — viewer-count signal', () => {
  it('reports the live connected-viewer count on add and remove', () => {
    const runId = `run-count-${Math.random()}`;
    const events: number[] = [];
    signallingProxyRegistry.setViewerCountListener((id, n) => { if (id === runId) events.push(n); });

    const a = new FakeSocket();
    const b = new FakeSocket();
    const ca = conn(runId, 'A', a);
    const cb = conn(runId, 'B', b);

    signallingProxyRegistry.add(ca);            // 1
    signallingProxyRegistry.add(cb);            // 2
    signallingProxyRegistry.remove(ca);         // 1
    signallingProxyRegistry.remove(cb);         // 0 (last viewer gone)

    expect(events).toEqual([1, 2, 1, 0]);
    expect(signallingProxyRegistry.viewerCount(runId)).toBe(0);
  });
});

describe('visualiserIdleReaper — viewer-aware arm/cancel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visualiserIdleReaper.init();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never arms a countdown while a viewer is connected', () => {
    if (visualiserIdleReaper.timeoutMs <= 0) return; // reaping disabled in this env
    const runId = `run-active-${Math.random()}`;
    const a = new FakeSocket();
    signallingProxyRegistry.add(conn(runId, 'A', a));
    expect(visualiserIdleReaper.pendingCount()).toBe(0);
    // A long wait with a viewer connected must NOT arm anything.
    vi.advanceTimersByTime(visualiserIdleReaper.timeoutMs * 2);
    expect(visualiserIdleReaper.pendingCount()).toBe(0);
    signallingProxyRegistry.remove(conn(runId, 'A', a));
    visualiserIdleReaper.cancel(runId); // tidy: the final remove arms a countdown
  });

  it('arms when the last viewer leaves and cancels when one rejoins', () => {
    if (visualiserIdleReaper.timeoutMs <= 0) return;
    const runId = `run-idle-${Math.random()}`;
    const a = new FakeSocket();
    const ca = conn(runId, 'A', a);

    signallingProxyRegistry.add(ca);
    signallingProxyRegistry.remove(ca);          // viewers → 0: arm countdown
    expect(visualiserIdleReaper.pendingCount()).toBe(1);

    // A reconnect before the window elapses must cancel the reap.
    const b = new FakeSocket();
    signallingProxyRegistry.add(conn(runId, 'B', b));
    expect(visualiserIdleReaper.pendingCount()).toBe(0);

    signallingProxyRegistry.remove(conn(runId, 'B', b));
    visualiserIdleReaper.cancel(runId); // tidy: avoid firing the real (DB) reap
    expect(visualiserIdleReaper.pendingCount()).toBe(0);
  });
});
