/**
 * Portal-brokered Google sign-in for the PRISM admin SPA.
 *
 * Validates the OAuth code via prism-permissions, checks provisioned admin flag
 * or legacy PORTAL_ADMIN_EMAILS, then issues the signed `prism_admin` cookie.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { adminUsers } from '../db/schema.js';
import { hashPassword, setAdminSession } from './adminSession.js';
import { getSetting } from '../db/settings.js';

interface PortalUser {
  userId: string;
  email: string;
  displayName?: string | null;
}

function pickFirstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'string') return value.split(',')[0]?.trim();
  return undefined;
}

export function resolvePublicOrigin(req: FastifyRequest): string {
  const env = (process.env.PUBLIC_BASE_URL ?? process.env.PRISM_PUBLIC_URL)?.trim();
  if (env) return env.replace(/\/$/, '');
  const xfHost = pickFirstHeader(req.headers['x-forwarded-host']);
  const xfProto = pickFirstHeader(req.headers['x-forwarded-proto']);
  const host = (xfHost ?? req.hostname ?? 'localhost').split(',')[0]?.trim() || 'localhost';
  const proto = (xfProto ?? req.protocol ?? 'https').split(',')[0]?.trim() || 'https';
  return `${proto}://${host}`;
}

async function parseAllowedEmails(): Promise<Set<string>> {
  const raw = (await getSetting('portal_admin_emails')) ?? process.env.PORTAL_ADMIN_EMAILS ?? '';
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function adminPortalCallbackUri(req: FastifyRequest): string {
  return `${resolvePublicOrigin(req)}/admin/?portal_callback=1`;
}

async function fetchProvisionedAdminCheck(email: string): Promise<{ allowed: boolean; prismAdminUsername?: string | null }> {
  const base = (process.env.PERMISSIONS_SERVICE_URL ?? 'http://prism-permissions:8771').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/access/provisioned-admin?email=${encodeURIComponent(email)}`);
    if (!res.ok) return { allowed: false };
    return (await res.json()) as { allowed: boolean; prismAdminUsername?: string | null };
  } catch {
    return { allowed: false };
  }
}

async function fetchPortalUser(portalAuthCode: string, redirectUri: string): Promise<PortalUser> {
  const base = (process.env.PERMISSIONS_SERVICE_URL ?? 'http://prism-permissions:8771').replace(/\/$/, '');
  const res = await fetch(`${base}/api/access/portal-user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ portalAuthCode, redirectUri }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Portal sign-in failed (${res.status})`);
  }
  const body = (await res.json()) as { user?: PortalUser };
  if (!body.user?.email) throw new Error('Portal returned an invalid user');
  return body.user;
}

function googleAdminUsername(email: string): string {
  const normalized = email.trim().toLowerCase();
  return normalized.length <= 64 ? normalized : (normalized.split('@')[0] ?? normalized);
}

/** Upsert a passwordless admin_users row for Google OAuth sign-in. */
async function upsertGoogleAdminUser(email: string): Promise<typeof adminUsers.$inferSelect | null> {
  const username = googleAdminUsername(email);
  const existing = await db.select().from(adminUsers).where(eq(adminUsers.username, username)).limit(1);
  if (existing[0]) {
    if (!existing[0].isActive) {
      await db.update(adminUsers).set({ isActive: true }).where(eq(adminUsers.id, existing[0].id));
    }
    return existing[0];
  }

  const passwordHash = await hashPassword(`${randomBytes(32).toString('hex')}:google-oauth-only`);
  const inserted = await db
    .insert(adminUsers)
    .values({ username, passwordHash, isActive: true })
    .returning();
  return inserted[0] ?? null;
}

async function findAdminUserForPortalEmail(email: string) {
  const normalized = email.trim().toLowerCase();

  const provisioned = await fetchProvisionedAdminCheck(normalized);
  if (provisioned.allowed) {
    if (provisioned.prismAdminUsername) {
      const bound = await db
        .select()
        .from(adminUsers)
        .where(eq(adminUsers.username, provisioned.prismAdminUsername.trim()))
        .limit(1);
      if (bound[0]?.isActive) return bound[0];
    }
    return upsertGoogleAdminUser(normalized);
  }

  const allowed = await parseAllowedEmails();
  if (!allowed.has(normalized)) return null;

  const byUsername = await db.select().from(adminUsers).where(eq(adminUsers.username, normalized)).limit(1);
  if (byUsername[0]?.isActive) return byUsername[0];

  return upsertGoogleAdminUser(normalized);
}

export async function loginAdminViaPortal(
  req: FastifyRequest,
  reply: FastifyReply,
  portalAuthCode: string,
  redirectUri: string,
): Promise<{ ok: true; username: string } | { ok: false; status: number; error: string }> {
  let portalUser: PortalUser;
  try {
    portalUser = await fetchPortalUser(portalAuthCode, redirectUri);
  } catch (err) {
    return {
      ok: false,
      status: 401,
      error: err instanceof Error ? err.message : 'Portal sign-in failed',
    };
  }

  const row = await findAdminUserForPortalEmail(portalUser.email);
  if (!row) {
    return {
      ok: false,
      status: 403,
      error: 'This Google account is not authorized for PRISM admin',
    };
  }

  await setAdminSession(req, reply, row);
  return { ok: true, username: row.username };
}

export async function buildGoogleLoginStartUrl(req: FastifyRequest): Promise<string | null> {
  const redirectUri = adminPortalCallbackUri(req);
  const adapter = (await getSetting('portal_adapter')) ?? process.env.PORTAL_ADAPTER ?? 'mock';

  if (adapter === 'mock') {
    const persona = (await getSetting('portal_mock_persona')) ?? process.env.PORTAL_MOCK_PERSONA ?? 'alice';
    return `/api/access/mock-login?redirect_uri=${encodeURIComponent(redirectUri)}&persona=${encodeURIComponent(persona)}`;
  }

  if (adapter === 'google') {
    const clientId = (await getSetting('google_oauth_client_id')) ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId) return null;
    const scopes =
      (await getSetting('google_oauth_scopes')) ?? process.env.GOOGLE_OAUTH_SCOPES ?? 'openid email profile';
    const domain = (await getSetting('workspace_domain')) ?? process.env.WORKSPACE_DOMAIN;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes);
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    if (domain) url.searchParams.set('hd', domain);
    return url.toString();
  }

  const authorizeBase = ((await getSetting('portal_google_authorize_url')) ?? process.env.PORTAL_GOOGLE_AUTHORIZE_URL)?.trim();
  if (!authorizeBase) return null;
  const url = new URL(authorizeBase);
  url.searchParams.set('redirect_uri', redirectUri);
  return url.toString();
}
