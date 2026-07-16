/**
 * Meshy.ai REST client. Uses the API key from Settings (`meshy_api_key`).
 * The browser never sees the key — all calls go through /api/meshy.
 *
 * Docs: https://docs.meshy.ai/en/api/quick-start
 */
import { getSetting } from '../db/settings.js';

const DEFAULT_BASE = 'https://api.meshy.ai';

export class MeshyClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'MeshyClientError';
  }
}

export type MeshyTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

export interface MeshyTask {
  id: string;
  status: MeshyTaskStatus;
  progress?: number;
  model_urls?: Partial<Record<'glb' | 'fbx' | 'obj' | 'usdz' | 'stl' | 'blend' | '3mf', string>>;
  thumbnail_url?: string | null;
  prompt?: string;
  type?: string;
  task_error?: { message?: string } | null;
  created_at?: number;
  started_at?: number;
  finished_at?: number;
  [key: string]: unknown;
}

async function resolveBaseUrl(): Promise<string> {
  const raw = (await getSetting('meshy_api_base_url'))?.trim();
  if (!raw) return DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}

export async function getMeshyApiKey(): Promise<string | undefined> {
  const key = (await getSetting('meshy_api_key'))?.trim();
  return key || undefined;
}

export async function isMeshyConfigured(): Promise<boolean> {
  return !!(await getMeshyApiKey());
}

async function meshyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const key = await getMeshyApiKey();
  if (!key) {
    throw new MeshyClientError('Meshy API key not configured. Set it in Admin → Settings → Meshy.', 412);
  }
  const base = await resolveBaseUrl();
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${key}`);
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...init, headers });
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (typeof o.message === 'string' && o.message.trim()) return o.message;
    if (typeof o.error === 'string' && o.error.trim()) return o.error;
    const detail = o.detail ?? o.error;
    if (detail && typeof detail === 'object' && typeof (detail as { message?: string }).message === 'string') {
      return (detail as { message: string }).message;
    }
  }
  if (typeof body === 'string' && body.trim()) return body.slice(0, 400);
  return fallback;
}

async function meshyJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await meshyFetch(path, init);
  const body = await parseJson(res);
  if (!res.ok) {
    throw new MeshyClientError(errorMessage(body, res.statusText || 'Meshy request failed'), res.status, body);
  }
  return body as T;
}

/** Lightweight credential check — hits the balance endpoint when available. */
export async function testMeshyConnection(): Promise<{
  ok: boolean;
  balance?: unknown;
  error?: string;
}> {
  try {
    const balance = await meshyJson<unknown>('/openapi/v1/balance');
    return { ok: true, balance };
  } catch (err) {
    if (err instanceof MeshyClientError && err.status === 404) {
      // Older accounts may not expose balance — treat authenticated 404 as ok
      // by verifying the key is present (request reached Meshy).
      return { ok: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function createTextTo3dTask(body: Record<string, unknown>): Promise<{ result: string }> {
  return meshyJson<{ result: string }>('/openapi/v2/text-to-3d', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getTextTo3dTask(id: string): Promise<MeshyTask> {
  return meshyJson<MeshyTask>(`/openapi/v2/text-to-3d/${encodeURIComponent(id)}`);
}

export async function createImageTo3dTask(body: Record<string, unknown>): Promise<{ result: string }> {
  return meshyJson<{ result: string }>('/openapi/v1/image-to-3d', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getImageTo3dTask(id: string): Promise<MeshyTask> {
  return meshyJson<MeshyTask>(`/openapi/v1/image-to-3d/${encodeURIComponent(id)}`);
}

/** Allowlist hostnames for Meshy asset downloads (signed URLs). */
export function isAllowedMeshyAssetUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'assets.meshy.ai'
      || host.endsWith('.meshy.ai')
      || host === 'cdn.meshy.ai';
  } catch {
    return false;
  }
}

export async function downloadMeshyAsset(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (!isAllowedMeshyAssetUrl(url)) {
    throw new MeshyClientError('Download URL is not a Meshy asset host', 400);
  }
  // Signed URLs are typically public; still send the Bearer when present.
  const res = await meshyFetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await parseJson(res);
    throw new MeshyClientError(errorMessage(body, 'Failed to download Meshy asset'), res.status, body);
  }
  const ab = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  return { bytes: Buffer.from(ab), contentType };
}
