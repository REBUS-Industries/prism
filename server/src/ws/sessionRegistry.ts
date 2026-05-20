/**
 * In-memory registry of live WS connections.
 *
 * Two flavours:
 *   - agent: one per PRISM.Agent.exe process
 *   - admin: one per open admin SPA tab (subscribed to job + workstation streams)
 *
 * `agent_sessions` rows in Postgres mirror the agent map and are how
 * the dispatcher discovers free slots — the registry is the in-process
 * fast path; the table is the durable copy that survives a server
 * restart (rows are deleted at clean shutdown and pruned on next boot).
 */
import type { WebSocket } from 'ws';
import type { HelloData } from '../../../shared/contracts/agent-protocol.js';

export interface AgentConn {
  sessionId: string;
  workstationId: string;       // FK -> workstations.id
  machineId: string;           // de-dup key: one active conn per machineId
  nodeName: string;
  socket: WebSocket;
  hello: HelloData;
  slotsBusy: number;
  connectedAt: Date;
  lastHeartbeat: Date;
  remoteAddr?: string | undefined;
}

export interface AdminConn {
  id: string;
  socket: WebSocket;
  connectedAt: Date;
  subscriptions: Set<string>;  // e.g. 'jobs', 'workstations', 'job:<uuid>'
}

class Registry {
  private agentsByMachine = new Map<string, AgentConn>();
  private agentsBySession = new Map<string, AgentConn>();
  private admins = new Map<string, AdminConn>();

  addAgent(conn: AgentConn): AgentConn | undefined {
    const old = this.agentsByMachine.get(conn.machineId);
    if (old) {
      // Replace stale conn (e.g. agent reconnected before old socket timed out)
      this.agentsBySession.delete(old.sessionId);
      try { old.socket.close(1001, 'replaced by newer connection'); } catch { /* ignore */ }
    }
    this.agentsByMachine.set(conn.machineId, conn);
    this.agentsBySession.set(conn.sessionId, conn);
    return old;
  }

  removeAgent(sessionId: string): AgentConn | undefined {
    const conn = this.agentsBySession.get(sessionId);
    if (!conn) return undefined;
    this.agentsBySession.delete(sessionId);
    if (this.agentsByMachine.get(conn.machineId) === conn) {
      this.agentsByMachine.delete(conn.machineId);
    }
    return conn;
  }

  getAgent(sessionId: string): AgentConn | undefined { return this.agentsBySession.get(sessionId); }
  getAgentByMachine(machineId: string): AgentConn | undefined { return this.agentsByMachine.get(machineId); }
  allAgents(): AgentConn[] { return [...this.agentsBySession.values()]; }

  addAdmin(conn: AdminConn): void { this.admins.set(conn.id, conn); }
  removeAdmin(id: string): void { this.admins.delete(id); }
  allAdmins(): AdminConn[] { return [...this.admins.values()]; }

  /** Fan a serialized message out to every admin whose subscriptions include `topic`. */
  broadcastAdmin(topic: string, frame: string): void {
    for (const a of this.admins.values()) {
      if (!a.subscriptions.has(topic) && !a.subscriptions.has('*')) continue;
      try { a.socket.send(frame); } catch { /* ignore broken sockets */ }
    }
  }
}

export const sessionRegistry = new Registry();
