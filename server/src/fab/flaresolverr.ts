/**
 * FlareSolverr client — obtains Cloudflare clearance cookies for Fab browse calls.
 *
 * Fab browse traffic must use a persistent FlareSolverr session: cf_clearance cookies
 * copied into undici requests are rejected (TLS/fingerprint mismatch). Session-based
 * request.get/post keeps traffic in FlareSolverr's browser.
 *
 * FlareSolverr must run on (or route through) the same egress IP as PRISM Fab HTTP
 * requests when using cookie-only mode with a proxy.
 */
import {
  InvalidHttpUrlError,
  isInvalidUrlError,
  isUnreachableNetworkError,
  normalizeHttpUrl,
  normalizeOptionalHttpUrl,
} from './urlValidation.js';

export class FlareSolverrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlareSolverrError';
  }
}

export interface FlareSolverrCookie {
  name: string;
  value: string;
  domain?: string;
}

export interface FlareSolverrSolution {
  url?: string;
  status?: number;
  cookies?: FlareSolverrCookie[];
  userAgent?: string;
  response?: string;
}

export interface FlareSolverrResponse {
  status?: string;
  message?: string;
  session?: string;
  solution?: FlareSolverrSolution;
}

export interface FlareSolverrSolveResult {
  cookies: FlareSolverrCookie[];
  userAgent?: string;
}

export interface FlareSolverrSessionFetchResult extends FlareSolverrSolveResult {
  status: number;
  response: string;
}

export interface FlareSolverrSessionFetchOptions {
  session: string;
  proxy?: string | null;
  maxTimeoutMs?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  postData?: string;
}

function normalizeSolverBaseUrl(url: string): string {
  const normalized = normalizeHttpUrl(url.trim());
  const trimmed = normalized.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) return trimmed;
  return `${trimmed}/v1`;
}

function isLoopbackHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function dockerFlareSolverrHint(endpoint: string): string {
  if (!isLoopbackHost(endpoint)) return '';
  return (
    ' In Docker, 127.0.0.1 is the PRISM container itself — use http://flaresolverr:8191/v1'
    + ' (docker-compose.dev.yml service) or http://host.docker.internal:8191/v1 (FlareSolverr on the VM host).'
  );
}

function mapFlareSolverrFetchError(err: unknown, endpoint: string): FlareSolverrError {
  if (isInvalidUrlError(err)) {
    return new FlareSolverrError(`FlareSolverr URL invalid: ${endpoint}`);
  }
  if (isUnreachableNetworkError(err)) {
    return new FlareSolverrError(
      `FlareSolverr unreachable at ${endpoint} — is FlareSolverr running and reachable from prism-materials?${dockerFlareSolverrHint(endpoint)}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'fetch failed') {
    return new FlareSolverrError(
      `FlareSolverr unreachable at ${endpoint} — connection failed.${dockerFlareSolverrHint(endpoint)}`,
    );
  }
  return new FlareSolverrError(`FlareSolverr request failed: ${message}`);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/** FlareSolverr wraps JSON API bodies in a minimal HTML shell — unwrap for Fab JSON.parse. */
export function unwrapFabApiResponseBody(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const preMatch = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (preMatch?.[1]) {
    const inner = decodeHtmlEntities(preMatch[1]).trim();
    if (inner.startsWith('{') || inner.startsWith('[')) return inner;
  }
  return raw;
}

async function flareSolverrPost(
  solverUrl: string,
  body: Record<string, unknown>,
  options?: { proxy?: string | null },
): Promise<FlareSolverrResponse> {
  let endpoint: string;
  try {
    endpoint = normalizeSolverBaseUrl(solverUrl);
  } catch (err) {
    const detail = err instanceof InvalidHttpUrlError ? err.message : 'Invalid URL';
    throw new FlareSolverrError(`FlareSolverr URL invalid: ${detail}`);
  }

  const payload = { ...body };
  const proxy = normalizeOptionalHttpUrl(options?.proxy);
  if (proxy) {
    try {
      payload.proxy = { url: normalizeHttpUrl(proxy) };
    } catch (err) {
      const detail = err instanceof InvalidHttpUrlError ? err.message : 'Invalid URL';
      throw new FlareSolverrError(`Fab HTTP proxy URL invalid for FlareSolverr: ${detail}`);
    }
  }

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw mapFlareSolverrFetchError(err, endpoint);
  }

  const text = await res.text().catch(() => '');
  let json: FlareSolverrResponse;
  try {
    json = JSON.parse(text) as FlareSolverrResponse;
  } catch {
    throw new FlareSolverrError(
      `FlareSolverr returned invalid JSON (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  if (!res.ok || json.status !== 'ok') {
    throw new FlareSolverrError(
      json.message ?? `FlareSolverr failed (${res.status})`,
    );
  }

  return json;
}

/** Create a FlareSolverr browser session (required for Fab browse calls). */
export async function flareSolverrSessionCreate(
  solverUrl: string,
  options?: { proxy?: string | null },
): Promise<string> {
  const json = await flareSolverrPost(solverUrl, { cmd: 'sessions.create' }, options);
  if (!json.session) {
    throw new FlareSolverrError('FlareSolverr sessions.create returned no session id');
  }
  return json.session;
}

/** Destroy a FlareSolverr session — best-effort cleanup. */
export async function flareSolverrSessionDestroy(
  solverUrl: string,
  sessionId: string,
): Promise<void> {
  try {
    await flareSolverrPost(solverUrl, { cmd: 'sessions.destroy', session: sessionId });
  } catch {
    // Session may already have expired on the FlareSolverr side.
  }
}

/** GET/POST a URL inside an existing FlareSolverr session. */
export async function flareSolverrSessionFetch(
  solverUrl: string,
  pageUrl: string,
  options: FlareSolverrSessionFetchOptions,
): Promise<FlareSolverrSessionFetchResult> {
  const method = options.method ?? 'GET';
  const cmd = method === 'POST' ? 'request.post' : 'request.get';
  const body: Record<string, unknown> = {
    cmd,
    url: pageUrl,
    session: options.session,
    maxTimeout: options.maxTimeoutMs ?? 60_000,
  };
  if (options.headers && Object.keys(options.headers).length > 0) {
    body.headers = options.headers;
  }
  if (method === 'POST' && options.postData !== undefined) {
    body.postData = options.postData;
  }

  const json = await flareSolverrPost(solverUrl, body, { proxy: options.proxy });
  if (!json.solution) {
    throw new FlareSolverrError(json.message ?? 'FlareSolverr returned no solution');
  }

  const solution = json.solution;
  return {
    cookies: solution.cookies ?? [],
    userAgent: solution.userAgent,
    status: solution.status ?? 200,
    response: unwrapFabApiResponseBody(solution.response ?? ''),
  };
}

/** POST request.get to FlareSolverr for the given page URL (one-shot, no session). */
export async function flareSolverrRequestGet(
  solverUrl: string,
  pageUrl: string,
  options?: { proxy?: string | null; maxTimeoutMs?: number },
): Promise<FlareSolverrSolveResult> {
  const body: Record<string, unknown> = {
    cmd: 'request.get',
    url: pageUrl,
    maxTimeout: options?.maxTimeoutMs ?? 60_000,
  };

  const json = await flareSolverrPost(solverUrl, body, { proxy: options?.proxy });
  if (!json.solution) {
    throw new FlareSolverrError(json.message ?? 'FlareSolverr returned no solution');
  }

  return {
    cookies: json.solution.cookies ?? [],
    userAgent: json.solution.userAgent,
  };
}

/** Map FlareSolverr cookies into a hostname-keyed jar (fab.com host only). */
export function injectFlareSolverrCookies(
  cookies: FlareSolverrCookie[],
  hostname: string,
  jar: Map<string, Map<string, string>>,
): void {
  let hostJar = jar.get(hostname);
  if (!hostJar) {
    hostJar = new Map();
    jar.set(hostname, hostJar);
  }
  for (const c of cookies) {
    if (!c.name || c.value === undefined) continue;
    const domain = c.domain?.replace(/^\./, '') ?? '';
    if (domain && domain !== hostname && !hostname.endsWith(`.${domain}`) && domain !== 'fab.com') {
      continue;
    }
    hostJar.set(c.name, c.value);
  }
}

export function hasCloudflareClearance(jar: Map<string, Map<string, string>>, hostname: string): boolean {
  return !!jar.get(hostname)?.get('cf_clearance');
}
