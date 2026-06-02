/**
 * In-memory tests for the multi-viewer signalling registry: per-viewer
 * frame routing (the fix for "second viewer freezes the first") and the
 * single-controller take/release lock. Pure state + routing — no DB, no
 * real sockets (a minimal fake captures sends/closes).
 */
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  signallingProxyRegistry,
  type BrowserConn,
  type ControlSub,
} from '../src/ws/signallingProxyRegistry.js';
import type { SignallingFrameData } from '../../shared/contracts/agent-protocol.js';

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<string | Buffer> = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string | Buffer) { this.sent.push(data); }
  close(code = 1000, reason = '') { this.closed = { code, reason }; this.readyState = 3; }
}

function conn(runId: string, viewerId: string, tier: 'view' | 'control', socket: FakeSocket): BrowserConn {
  return { socket: socket as unknown as WebSocket, agentSessionId: `agent-${runId}`, runId, viewerId, tier };
}

function frame(runId: string, viewerId: string | undefined, payload: string): SignallingFrameData {
  return { runId, viewerId, payload } as SignallingFrameData;
}

function lastControlState(sock: FakeSocket): { controllerViewerId: string | null; youAreController: boolean; canControl: boolean } {
  const msgs = sock.sent.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m));
  const ctl = [...msgs].reverse().find((m) => m.type === 'controller');
  return ctl;
}

describe('signallingProxyRegistry — per-viewer demux', () => {
  it('routes an agent frame only to the matching viewer', () => {
    const runId = `run-demux-${Math.random()}`;
    const a = new FakeSocket(); const b = new FakeSocket();
    signallingProxyRegistry.add(conn(runId, 'A', 'control', a));
    signallingProxyRegistry.add(conn(runId, 'B', 'view', b));

    signallingProxyRegistry.forwardAgentToBrowser(frame(runId, 'A', '{"type":"offer"}'));
    expect(a.sent).toEqual(['{"type":"offer"}']);
    expect(b.sent).toEqual([]); // B must NOT see A's SDP (the old broadcast bug)

    signallingProxyRegistry.forwardAgentToBrowser(frame(runId, 'B', '{"type":"answer"}'));
    expect(b.sent).toEqual(['{"type":"answer"}']);
    expect(a.sent).toEqual(['{"type":"offer"}']);
  });

  it('broadcasts when the frame carries no viewerId (legacy agent)', () => {
    const runId = `run-legacy-${Math.random()}`;
    const a = new FakeSocket(); const b = new FakeSocket();
    signallingProxyRegistry.add(conn(runId, 'A', 'control', a));
    signallingProxyRegistry.add(conn(runId, 'B', 'view', b));
    signallingProxyRegistry.forwardAgentToBrowser(frame(runId, undefined, '{"type":"x"}'));
    expect(a.sent).toEqual(['{"type":"x"}']);
    expect(b.sent).toEqual(['{"type":"x"}']);
  });
});

describe('signallingProxyRegistry — controller lock', () => {
  it('auto-grants the first control viewer, not a second one', () => {
    const runId = `run-auto-${Math.random()}`;
    signallingProxyRegistry.add(conn(runId, 'A', 'control', new FakeSocket()));
    const g1 = signallingProxyRegistry.autoGrantIfVacant(runId, 'A', 'control');
    expect(g1.changed).toBe(true);
    expect(g1.promoted).toBe('A');
    expect(signallingProxyRegistry.controllerState(runId).controllerViewerId).toBe('A');

    const g2 = signallingProxyRegistry.autoGrantIfVacant(runId, 'B', 'control');
    expect(g2.changed).toBe(false);
    expect(signallingProxyRegistry.controllerState(runId).controllerViewerId).toBe('A');
  });

  it('never auto-grants a view-tier viewer', () => {
    const runId = `run-view-${Math.random()}`;
    const g = signallingProxyRegistry.autoGrantIfVacant(runId, 'V', 'view');
    expect(g.changed).toBe(false);
    expect(signallingProxyRegistry.controllerState(runId).controllerViewerId).toBeNull();
  });

  it('take demotes the previous controller; view tier cannot take', () => {
    const runId = `run-take-${Math.random()}`;
    signallingProxyRegistry.add(conn(runId, 'A', 'control', new FakeSocket()));
    signallingProxyRegistry.add(conn(runId, 'B', 'control', new FakeSocket()));
    signallingProxyRegistry.autoGrantIfVacant(runId, 'A', 'control');

    const denied = signallingProxyRegistry.takeControl(runId, 'V', 'view');
    expect(denied.ok).toBe(false);
    expect(signallingProxyRegistry.controllerState(runId).controllerViewerId).toBe('A');

    const taken = signallingProxyRegistry.takeControl(runId, 'B', 'control');
    expect(taken.ok).toBe(true);
    expect(taken.demoted).toBe('A');
    expect(taken.promoted).toBe('B');
    expect(signallingProxyRegistry.controllerState(runId).controllerViewerId).toBe('B');
  });

  it('release clears the lock only for the current controller', () => {
    const runId = `run-rel-${Math.random()}`;
    signallingProxyRegistry.add(conn(runId, 'A', 'control', new FakeSocket()));
    signallingProxyRegistry.autoGrantIfVacant(runId, 'A', 'control');

    const noop = signallingProxyRegistry.releaseControl(runId, 'B'); // not the controller
    expect(noop.changed).toBe(false);
    expect(signallingProxyRegistry.controllerState(runId).controllerViewerId).toBe('A');

    const released = signallingProxyRegistry.releaseControl(runId, 'A');
    expect(released.changed).toBe(true);
    expect(released.demoted).toBe('A');
    expect(signallingProxyRegistry.controllerState(runId).controllerViewerId).toBeNull();
  });

  it('removing the controlling viewer clears the lock', () => {
    const runId = `run-remove-${Math.random()}`;
    const a = new FakeSocket();
    const c = conn(runId, 'A', 'control', a);
    signallingProxyRegistry.add(c);
    signallingProxyRegistry.autoGrantIfVacant(runId, 'A', 'control');
    const res = signallingProxyRegistry.remove(c);
    expect(res.wasController).toBe(true);
    expect(signallingProxyRegistry.controllerState(runId).controllerViewerId).toBeNull();
  });

  it('control subscriber receives current state on subscribe and on change', () => {
    const runId = `run-sub-${Math.random()}`;
    signallingProxyRegistry.add(conn(runId, 'A', 'control', new FakeSocket()));
    signallingProxyRegistry.autoGrantIfVacant(runId, 'A', 'control');

    const subSock = new FakeSocket();
    const sub: ControlSub = { socket: subSock as unknown as WebSocket, viewerId: 'A', tier: 'control' };
    signallingProxyRegistry.addControlSub(runId, sub);
    // Immediate push reflects A is the controller.
    expect(lastControlState(subSock)).toMatchObject({ controllerViewerId: 'A', youAreController: true, canControl: true });

    // A different viewer takes control → subscriber A is notified it lost it.
    signallingProxyRegistry.add(conn(runId, 'B', 'control', new FakeSocket()));
    signallingProxyRegistry.takeControl(runId, 'B', 'control');
    expect(lastControlState(subSock)).toMatchObject({ controllerViewerId: 'B', youAreController: false, canControl: true });
  });
});
