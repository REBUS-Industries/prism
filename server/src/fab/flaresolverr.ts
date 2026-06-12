/**
 * FlareSolverr client — obtains Cloudflare clearance cookies for Fab browse calls.
 *
 * FlareSolverr must run on (or route through) the same egress IP as PRISM Fab HTTP
 * requests. Solving a challenge in a browser on a residential PC does not help
 * unless that browser uses the same HTTP proxy configured for Fab.
 */

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
  solution?: FlareSolverrSolution;
}

export interface FlareSolverrSolveResult {
  cookies: FlareSolverrCookie[];
  userAgent?: string;
}

function normalizeSolverBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) return trimmed;
  return `${trimmed}/v1`;
}

/** POST request.get to FlareSolverr for the given page URL. */
export async function flareSolverrRequestGet(
  solverUrl: string,
  pageUrl: string,
  options?: { proxy?: string | null; maxTimeoutMs?: number },
): Promise<FlareSolverrSolveResult> {
  const endpoint = normalizeSolverBaseUrl(solverUrl);
  const body: Record<string, unknown> = {
    cmd: 'request.get',
    url: pageUrl,
    maxTimeout: options?.maxTimeoutMs ?? 60_000,
  };
  const proxy = options?.proxy?.trim();
  if (proxy) body.proxy = { url: proxy };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => '');
  let json: FlareSolverrResponse;
  try {
    json = JSON.parse(text) as FlareSolverrResponse;
  } catch {
    throw new FlareSolverrError(
      `FlareSolverr returned invalid JSON (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  if (!res.ok || json.status !== 'ok' || !json.solution) {
    throw new FlareSolverrError(
      json.message ?? `FlareSolverr failed (${res.status})`,
    );
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
