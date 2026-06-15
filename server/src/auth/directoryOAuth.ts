/**
 * One-time OAuth for Google Admin SDK directory sync without service account keys.
 * Used when org policy `iam.disableServiceAccountKeyCreation` blocks JSON keys.
 */
import type { FastifyRequest } from 'fastify';
import { getSetting, setSetting } from '../db/settings.js';
import { resolvePublicOrigin } from './portalAdminLogin.js';

export const DIRECTORY_READONLY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

export function directoryOAuthCallbackUri(req: FastifyRequest): string {
  return `${resolvePublicOrigin(req)}/api/admin/directory-oauth/callback`;
}

export async function buildDirectoryOAuthStartUrl(req: FastifyRequest): Promise<string | null> {
  const clientId = (await getSetting('google_oauth_client_id')) ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) return null;

  const redirectUri = directoryOAuthCallbackUri(req);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DIRECTORY_READONLY_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export async function saveDirectoryOAuthRefreshToken(code: string, redirectUri: string): Promise<void> {
  const clientId = (await getSetting('google_oauth_client_id')) ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = (await getSetting('google_oauth_client_secret')) ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth client ID and secret must be configured before authorizing directory sync');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${detail}`);
  }

  const body = (await res.json()) as { refresh_token?: string };
  if (!body.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke prior PRISM access at myaccount.google.com/permissions and retry.',
    );
  }

  await setSetting('google_workspace_directory_refresh_token', body.refresh_token);
}
