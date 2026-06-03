/**
 * Server-side API-call log — an in-memory ring buffer that captures safe
 * metadata for every inbound HTTP request the server answers.
 *
 * This backs the admin Logs page, which previously only showed the admin
 * SPA's own browser fetches (a client-side ring buffer in
 * web/src/shared/api.ts). The server-side buffer additionally surfaces
 * EXTERNAL API-key calls (`/v1/*`, `/api/visualiser/*`), ORBIT-bearer
 * calls, and internal download-token traffic — none of which ever reach
 * the admin browser and so were invisible before.
 *
 * SECRETS: we record only method, path, status, duration, the coarse
 * principal kind, a human-friendly principal label, the client IP, and a
 * derived category/level. We NEVER record header values (no Authorization
 * / X-API-Key), cookies, or request/response bodies, so no credential can
 * leak into the buffer. Known-sensitive query parameters (token, share
 * tokens, api keys) are additionally redacted from the recorded path.
 */
import type { OriginKind } from '../auth/provenance.js';

export type ApiLogCategory = 'external' | 'admin' | 'orbit' | 'internal' | 'system';
export type ApiLogLevel = 'info' | 'warn' | 'error';

export interface ServerApiLogEntry {
  id: number;
  /** Request start, epoch ms. */
  ts: number;
  durationMs: number;
  method: string;
  /** Path + redacted query string (never the full URL with secrets). */
  path: string;
  status: number;
  originKind: OriginKind;
  originPrincipal: string | null;
  clientIp: string | null;
  category: ApiLogCategory;
  level: ApiLogLevel;
}

// Bounded like the client buffer (web/src/shared/api.ts uses 250); the server
// fields more traffic so we keep a larger but still bounded window.
const MAX_ENTRIES = 1000;
const SENSITIVE_QUERY_KEYS = new Set(['token', 'st', 'sharetoken', 'share_token', 'key', 'apikey', 'api_key', 'secret', 'password']);

class ServerApiLog {
  private entries: ServerApiLogEntry[] = [];
  private nextId = 1;

  /** Push a new entry; oldest are evicted past {@link MAX_ENTRIES}. Returns the assigned id. */
  push(entry: Omit<ServerApiLogEntry, 'id'>): number {
    const id = this.nextId++;
    this.entries.push({ id, ...entry });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    return id;
  }

  /**
   * Return entries with id strictly greater than `sinceId`, oldest-first,
   * capped at `limit`. `sinceId <= 0` returns the most recent `limit`
   * entries (still oldest-first within that window) so a fresh page load
   * gets a useful backlog without the whole buffer.
   */
  list(sinceId = 0, limit = MAX_ENTRIES): ServerApiLogEntry[] {
    if (sinceId > 0) {
      const out: ServerApiLogEntry[] = [];
      for (const e of this.entries) {
        if (e.id > sinceId) out.push(e);
        if (out.length >= limit) break;
      }
      return out;
    }
    return this.entries.slice(-limit);
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number { return this.entries.length; }
}

export const serverApiLog = new ServerApiLog();

/** Redact secret-bearing query params from a raw request url for safe display. */
export function redactPath(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return rawUrl;
  const path = rawUrl.slice(0, qIdx);
  const params = new URLSearchParams(rawUrl.slice(qIdx + 1));
  let mutated = false;
  for (const k of [...params.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) {
      params.set(k, '***');
      mutated = true;
    }
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}?${mutated ? decodeURIComponent(qs) : rawUrl.slice(qIdx + 1)}`;
}

export function categoryFor(path: string, originKind: OriginKind): ApiLogCategory {
  if (path.startsWith('/v1') || originKind === 'api') return 'external';
  if (path.startsWith('/internal')) return 'internal';
  if (originKind === 'admin') return 'admin';
  if (originKind === 'orbit') return 'orbit';
  return 'system';
}

export function levelFor(status: number): ApiLogLevel {
  if (status >= 500 || status === 0) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}
