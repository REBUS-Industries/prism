/**
 * Epic Games OAuth session + Fab HTTP client for authenticated download endpoints.
 *
 * Fab import requires an Epic account that owns (or can acquire free) the
 * target material. Configure a long-lived refresh token on the server:
 *
 *   FAB_EPIC_REFRESH_TOKEN=<refresh_token>
 *
 * Obtain the refresh token once via Epic's OAuth authorization-code flow
 * (launcher public client `34a02cf8f4414e29b15921876da36f9a`). The server
 * refreshes access tokens automatically and never exposes credentials to the
 * browser.
 *
 * Fab search/detail use a cookie-aware undici client with browser-like headers
 * to avoid Cloudflare bot challenges. When FAB_EPIC_REFRESH_TOKEN is set, browse
 * calls also send the Epic bearer token and CSRF cookies together — bearer alone
 * does not bypass Cloudflare on www.fab.com; use FAB_HTTP_PROXY when blocked.
 */
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import {
  FlareSolverrError,
  flareSolverrRequestGet,
  hasCloudflareClearance,
  injectFlareSolverrCookies,
} from './flaresolverr.js';
import {
  InvalidHttpUrlError,
  isInvalidUrlError,
  isUnreachableNetworkError,
  normalizeHttpUrl,
  normalizeOptionalHttpUrl,
} from './urlValidation.js';

const EPIC_TOKEN_URL = 'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token';
const EPIC_CLIENT_ID = process.env.FAB_EPIC_CLIENT_ID ?? '34a02cf8f4414e29b15921876da36f9a';
const EPIC_CLIENT_SECRET = process.env.FAB_EPIC_CLIENT_SECRET ?? 'daafbccc737745039dffe53d94fc76cf';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const FAB_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Origin: 'https://www.fab.com',
  Referer: 'https://www.fab.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
};

/** Thrown when Epic OAuth refresh fails — distinct from Cloudflare blocks. */
export class FabOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FabOAuthError';
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

let cachedAccessToken: string | null = null;
let cachedRefreshToken: string | null = process.env.FAB_EPIC_REFRESH_TOKEN?.trim() || null;
let cachedHttpProxy: string | null = process.env.FAB_HTTP_PROXY?.trim() || null;
let cachedFlareSolverrUrl: string | null = process.env.FAB_FLARESOLVERR_URL?.trim() || null;
let tokenExpiresAt = 0;
let flareSolverrPrimedAt = 0;
const FLARESOLVERR_TTL_MS = 20 * 60 * 1000;
const FAB_HOSTNAME = 'www.fab.com';

/** In-memory cookie jar keyed by hostname. */
const cookieJar = new Map<string, Map<string, string>>();

let fabAgent: Dispatcher | null = null;
let fabAgentProxy: string | null | undefined = undefined;

function fabDispatcher(): Dispatcher {
  const proxy = cachedHttpProxy?.trim() || null;
  if (fabAgent && fabAgentProxy === proxy) return fabAgent;
  fabAgentProxy = proxy;
  if (proxy) {
    try {
      normalizeHttpUrl(proxy);
      fabAgent = new ProxyAgent(proxy);
    } catch (err) {
      const detail = err instanceof InvalidHttpUrlError ? err.message : 'Invalid URL';
      throw new Error(`Fab HTTP proxy URL invalid: ${detail}`);
    }
  } else {
    fabAgent = new Agent({ connect: { timeout: 30_000 } });
  }
  return fabAgent;
}

function mapFabHttpError(err: unknown): Error {
  const proxy = cachedHttpProxy?.trim();
  if (proxy) {
    if (isInvalidUrlError(err)) {
      return new Error(`Fab HTTP proxy URL invalid: ${proxy}`);
    }
    if (isUnreachableNetworkError(err)) {
      return new Error(`Fab HTTP proxy unreachable: ${proxy}`);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

function hostnameFromUrl(url: string): string {
  return new URL(url).hostname;
}

function parseSetCookie(header: string, hostname: string): void {
  const part = header.split(';')[0]?.trim();
  if (!part || !part.includes('=')) return;
  const eq = part.indexOf('=');
  const name = part.slice(0, eq).trim();
  const value = part.slice(eq + 1).trim();
  if (!name) return;
  let jar = cookieJar.get(hostname);
  if (!jar) {
    jar = new Map();
    cookieJar.set(hostname, jar);
  }
  jar.set(name, value);
}

function cookieJarFor(url: string): Map<string, string> | undefined {
  return cookieJar.get(hostnameFromUrl(url));
}

function cookieHeaderFor(url: string): string | undefined {
  const jar = cookieJarFor(url);
  if (!jar?.size) return undefined;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function csrfTokenFor(url: string): string | undefined {
  return cookieJarFor(url)?.get('fab_csrftoken');
}

function storeResponseCookies(url: string, headers: Headers): void {
  const hostname = hostnameFromUrl(url);
  const raw = headers.getSetCookie?.() ?? [];
  if (raw.length) {
    for (const line of raw) parseSetCookie(line, hostname);
    return;
  }
  const single = headers.get('set-cookie');
  if (single) {
    for (const line of single.split(/,(?=[^;]+?=)/)) parseSetCookie(line.trim(), hostname);
  }
}

async function fabUndiciFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(FAB_BROWSER_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  const cookies = cookieHeaderFor(url);
  if (cookies) headers.set('Cookie', cookies);
  const csrf = csrfTokenFor(url);
  if (csrf && !headers.has('X-CSRFToken')) headers.set('X-CSRFToken', csrf);

  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, {
      ...init,
      headers,
      dispatcher: fabDispatcher(),
    });
  } catch (err) {
    throw mapFabHttpError(err);
  }

  storeResponseCookies(url, res.headers);
  return res as unknown as Response;
}

export function fabAuthConfigured(): boolean {
  return !!cachedRefreshToken;
}

export function fabHttpProxyConfigured(): boolean {
  return !!cachedHttpProxy?.trim();
}

export function fabFlareSolverrConfigured(): boolean {
  return !!cachedFlareSolverrUrl?.trim();
}

/** Apply Fab runtime config from DB settings (overrides env when loaded). */
export function applyFabRuntimeConfig(config: {
  refreshToken?: string | null;
  httpProxy?: string | null;
  flareSolverrUrl?: string | null;
}): void {
  if (config.refreshToken !== undefined) {
    cachedRefreshToken = config.refreshToken?.trim() || null;
    cachedAccessToken = null;
    tokenExpiresAt = 0;
  }
  if (config.httpProxy !== undefined) {
    cachedHttpProxy = normalizeOptionalHttpUrl(config.httpProxy);
    fabAgent = null;
    fabAgentProxy = undefined;
  }
  if (config.flareSolverrUrl !== undefined) {
    cachedFlareSolverrUrl = normalizeOptionalHttpUrl(config.flareSolverrUrl);
    flareSolverrPrimedAt = 0;
  }
}

export function setFabRefreshTokenForTests(token: string | null): void {
  cachedRefreshToken = token;
  cachedAccessToken = null;
  tokenExpiresAt = 0;
}

export function clearFabCookieJarForTests(): void {
  cookieJar.clear();
  flareSolverrPrimedAt = 0;
}

export function setFabFlareSolverrUrlForTests(url: string | null): void {
  cachedFlareSolverrUrl = url;
  flareSolverrPrimedAt = 0;
}

async function exchangeToken(params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({ ...params, token_type: 'eg1' });
  const auth = Buffer.from(`${EPIC_CLIENT_ID}:${EPIC_CLIENT_SECRET}`).toString('base64');
  const res = await undiciFetch(EPIC_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    dispatcher: fabDispatcher(),
  });
  const json = await res.json() as TokenResponse;
  if (!res.ok || json.error) {
    throw new FabOAuthError(json.error_description ?? json.error ?? `Epic OAuth failed (${res.status})`);
  }
  return json;
}

export async function getFabAccessToken(): Promise<string> {
  if (!cachedRefreshToken) {
    throw new FabOAuthError('Fab import not configured — set FAB_EPIC_REFRESH_TOKEN on the server');
  }
  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const json = await exchangeToken({
    grant_type: 'refresh_token',
    refresh_token: cachedRefreshToken,
  });
  if (!json.access_token) throw new FabOAuthError('Epic OAuth returned no access_token');
  cachedAccessToken = json.access_token;
  if (json.refresh_token) cachedRefreshToken = json.refresh_token;
  tokenExpiresAt = now + (json.expires_in ?? 3600) * 1000;
  return cachedAccessToken;
}

export async function fabAuthorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getFabAccessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `bearer ${token}`);
  return fabUndiciFetch(url, { ...init, headers });
}

export async function fabPublicFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fabUndiciFetch(url, init);
}

/**
 * Fab search/detail — uses bearer when configured, otherwise cookie-primed public fetch.
 * When a refresh token is configured, OAuth failures are surfaced (no silent public fallback).
 */
export async function fabBrowseFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (fabAuthConfigured()) {
    return fabAuthorizedFetch(url, init);
  }
  return fabPublicFetch(url, init);
}

/** Whether Fab browse calls will use Epic bearer auth (for diagnostics). */
export function fabBrowseAuthPath(): 'bearer' | 'public' {
  return fabAuthConfigured() ? 'bearer' : 'public';
}

/**
 * Obtain Cloudflare clearance via FlareSolverr when configured.
 * Re-runs when TTL expires or cf_clearance is missing from the jar.
 */
export async function ensureFabCloudflareAccess(force = false): Promise<void> {
  const solverUrl = cachedFlareSolverrUrl?.trim();
  if (!solverUrl) return;

  const now = Date.now();
  if (
    !force
    && flareSolverrPrimedAt
    && now - flareSolverrPrimedAt < FLARESOLVERR_TTL_MS
    && hasCloudflareClearance(cookieJar, FAB_HOSTNAME)
  ) {
    return;
  }

  const { cookies } = await flareSolverrRequestGet(solverUrl, 'https://www.fab.com/', {
    proxy: cachedHttpProxy,
  });
  injectFlareSolverrCookies(cookies, FAB_HOSTNAME, cookieJar);
  flareSolverrPrimedAt = now;
}

/** Prime Fab CSRF cookie jar — best-effort before Fab browse calls. */
export async function ensureFabCsrf(): Promise<void> {
  if (cachedFlareSolverrUrl?.trim()) {
    try {
      await ensureFabCloudflareAccess();
    } catch (err) {
      if (err instanceof FlareSolverrError) throw err;
      throw new FlareSolverrError(err instanceof Error ? err.message : 'FlareSolverr failed');
    }
  }
  await fabBrowseFetch('https://www.fab.com/i/csrf');
}

export { USER_AGENT };
