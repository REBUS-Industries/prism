/**
 * HTTP(S) URL normalization and validation for Fab HTTP proxy and FlareSolverr.
 */

export class InvalidHttpUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHttpUrlError';
  }
}

/** Trim; empty/whitespace → null (unset). */
export function normalizeOptionalHttpUrl(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return null;
  return normalizeHttpUrl(trimmed);
}

/** Normalize and validate an HTTP(S) URL. Auto-prefixes http:// for host:port forms. */
export function normalizeHttpUrl(raw: string): string {
  let url = raw.trim();
  if (!url) {
    throw new InvalidHttpUrlError('URL is required');
  }
  if (!/^https?:\/\//i.test(url)) {
    if (/^[\w.-]+:\d+(\/.*)?$/i.test(url)) {
      url = `http://${url}`;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidHttpUrlError(`Invalid URL: ${raw.trim()}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidHttpUrlError(`URL must use http:// or https://: ${raw.trim()}`);
  }
  return url;
}

const INVALID_URL_MARKERS = [
  'invalid url',
  'failed to parse url',
  'proxy uri is mandatory',
  'invalid url protocol',
];

export function isInvalidUrlError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return INVALID_URL_MARKERS.some((m) => message.includes(m));
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isUnreachableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code && UNREACHABLE_CODES.has(cause.code)) return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message === 'fetch failed' || message.includes('network') || message.includes('connect');
}
