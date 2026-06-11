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
 * to avoid Cloudflare bot challenges. When FAB_EPIC_REFRESH_TOKEN is set, those
 * calls also send the Epic bearer token.
 */
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

const EPIC_TOKEN_URL = 'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token';
const EPIC_CLIENT_ID = process.env.FAB_EPIC_CLIENT_ID ?? '34a02cf8f4414e29b15921876da36f9a';
const EPIC_CLIENT_SECRET = process.env.FAB_EPIC_CLIENT_SECRET ?? 'daafbccc737745039dffe53d94fc76cf';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const FAB_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
};

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
let tokenExpiresAt = 0;

/** In-memory cookie jar keyed by hostname. */
const cookieJar = new Map<string, Map<string, string>>();

let fabAgent: Dispatcher | null = null;
let fabAgentProxy: string | null | undefined = undefined;

function fabDispatcher(): Dispatcher {
  const proxy = cachedHttpProxy?.trim() || null;
  if (fabAgent && fabAgentProxy === proxy) return fabAgent;
  fabAgentProxy = proxy;
  fabAgent = proxy ? new ProxyAgent(proxy) : new Agent({ connect: { timeout: 30_000 } });
  return fabAgent;
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

function cookieHeaderFor(url: string): string | undefined {
  const jar = cookieJar.get(hostnameFromUrl(url));
  if (!jar?.size) return undefined;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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

  const res = await undiciFetch(url, {
    ...init,
    headers,
    dispatcher: fabDispatcher(),
  });

  storeResponseCookies(url, res.headers);
  return res as unknown as Response;
}

export function fabAuthConfigured(): boolean {
  return !!cachedRefreshToken;
}

/** Apply Fab runtime config from DB settings (overrides env when loaded). */
export function applyFabRuntimeConfig(config: {
  refreshToken?: string | null;
  httpProxy?: string | null;
}): void {
  if (config.refreshToken !== undefined) {
    cachedRefreshToken = config.refreshToken?.trim() || null;
    cachedAccessToken = null;
    tokenExpiresAt = 0;
  }
  if (config.httpProxy !== undefined) {
    cachedHttpProxy = config.httpProxy?.trim() || null;
    fabAgent = null;
    fabAgentProxy = undefined;
  }
}

export function setFabRefreshTokenForTests(token: string | null): void {
  cachedRefreshToken = token;
  cachedAccessToken = null;
  tokenExpiresAt = 0;
}

export function clearFabCookieJarForTests(): void {
  cookieJar.clear();
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
    throw new Error(json.error_description ?? json.error ?? `Epic OAuth failed (${res.status})`);
  }
  return json;
}

export async function getFabAccessToken(): Promise<string> {
  if (!cachedRefreshToken) {
    throw new Error('Fab import not configured — set FAB_EPIC_REFRESH_TOKEN on the server');
  }
  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const json = await exchangeToken({
    grant_type: 'refresh_token',
    refresh_token: cachedRefreshToken,
  });
  if (!json.access_token) throw new Error('Epic OAuth returned no access_token');
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
 */
export async function fabBrowseFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (fabAuthConfigured()) {
    try {
      return await fabAuthorizedFetch(url, init);
    } catch {
      // Fall back to public cookie session if token refresh fails.
    }
  }
  return fabPublicFetch(url, init);
}

/** Prime Fab CSRF cookie jar — best-effort before Fab browse calls. */
export async function ensureFabCsrf(): Promise<void> {
  await fabPublicFetch('https://www.fab.com/i/csrf');
}

export { USER_AGENT };
