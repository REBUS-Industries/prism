/**
 * Epic Games OAuth session for authenticated Fab download endpoints.
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
 */
import { Agent, fetch as undiciFetch } from 'undici';

const EPIC_TOKEN_URL = 'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token';
const EPIC_CLIENT_ID = process.env.FAB_EPIC_CLIENT_ID ?? '34a02cf8f4414e29b15921876da36f9a';
const EPIC_CLIENT_SECRET = process.env.FAB_EPIC_CLIENT_SECRET ?? 'daafbccc737745039dffe53d94fc76cf';

const USER_AGENT = 'UELauncher/17.0.1-37584233+++Portal+Release-Live Windows/10.0.19043.1.0.64bit';

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
let tokenExpiresAt = 0;

export function fabAuthConfigured(): boolean {
  return !!cachedRefreshToken;
}

export function setFabRefreshTokenForTests(token: string | null): void {
  cachedRefreshToken = token;
  cachedAccessToken = null;
  tokenExpiresAt = 0;
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
    dispatcher: new Agent({ connect: { timeout: 30_000 } }),
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
  headers.set('User-Agent', USER_AGENT);
  return fetch(url, { ...init, headers });
}

export async function fabPublicFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('User-Agent', USER_AGENT);
  headers.set('Accept', 'application/json');
  return fetch(url, { ...init, headers });
}

/** Prime Fab CSRF cookie jar — best-effort before authorized Fab calls. */
export async function ensureFabCsrf(): Promise<void> {
  await fabPublicFetch('https://www.fab.com/i/csrf');
}

export { USER_AGENT };
