/**
 * Typed settings accessor. The `settings` table is a free-form key/value
 * store, but every key PRISM reads goes through one of these helpers so
 * we have a single place to add validation, defaults, and types.
 */
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { settings } from './schema.js';

const ENV_FALLBACKS: Partial<Record<SettingKey | LegacySettingKey, string | undefined>> = {
  orbit_server_url:     process.env.ORBIT_SERVER_URL,
  orbit_dev_server_url: process.env.ORBIT_DEV_SERVER_URL,
  job_retention_hours:  process.env.JOB_RETENTION_HOURS ?? '720',
  maintenance_mode:     process.env.MAINTENANCE_MODE ?? '0',
  portal_adapter: process.env.PORTAL_ADAPTER ?? 'mock',
  portal_base_url: process.env.PORTAL_BASE_URL ?? 'https://portal.rebus.industries',
  portal_api_key: process.env.PORTAL_API_KEY,
  portal_google_authorize_url: process.env.PORTAL_GOOGLE_AUTHORIZE_URL,
  portal_mock_persona: process.env.PORTAL_MOCK_PERSONA ?? 'alice',
  portal_admin_emails: process.env.PORTAL_ADMIN_EMAILS,
  portal_admin_username: process.env.PORTAL_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin',
  workspace_adapter: process.env.WORKSPACE_ADAPTER ?? 'mock',
  workspace_domain: process.env.WORKSPACE_DOMAIN,
  workspace_admin_email: process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL,
  workspace_enforce_provisioned: process.env.WORKSPACE_ENFORCE_PROVISIONED ?? '1',
  workspace_grant_all_projects: process.env.WORKSPACE_GRANT_ALL_PROJECTS ?? '0',
  workspace_default_project_level: process.env.WORKSPACE_DEFAULT_PROJECT_LEVEL ?? 'contributor',
  google_oauth_client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  google_oauth_client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  google_oauth_scopes: process.env.GOOGLE_OAUTH_SCOPES ?? 'openid email profile',
  google_service_account_json: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  google_workspace_directory_refresh_token: process.env.GOOGLE_WORKSPACE_DIRECTORY_REFRESH_TOKEN,
};

export type SettingKey =
  | 'orbit_server_url'
  | 'orbit_dev_server_url'
  | 'orbit_token'
  | 'orbit_dev_token'
  | 'job_retention_hours'
  | 'maintenance_mode'
  // Optional override for the WSS endpoint baked into the per-node agent
  // config template. Falls back to wss://<request host>/ws/agent.
  | 'workstation_agent_ws_url'
  // Optional DNS suffix appended to each workstation's `nodeName` when the
  // admin SPA builds an "Open Web UI" link (http://<host>:7421/). Useful
  // for browsers in subnets whose DNS search list does not include the
  // workstation's domain (e.g. opening the admin UI from a workstation
  // outside the AD-joined VLAN). Leave blank to keep the bare `nodeName`
  // behaviour. Stored as e.g. `ad.rebus.industries` -- no leading dot,
  // no protocol, no port.
  | 'workstation_dns_suffix'
  // Persisted Vue Flow node positions for the admin Pipeline page. Stored
  // as a JSON string of shape:
  //   { "<pipelineId>": { "<nodeId>": { "x": number, "y": number } } }
  // Missing pipelines / nodes fall back to the auto-layout in
  // FlowEditor.vue. Cleared per-pipeline when the user clicks "Reset
  // layout"; cleared globally if the value fails to parse.
  | 'pipeline_layout_v1'
  | 'gdtf_share_username'
  | 'gdtf_share_password'
  // External material providers (Fab / Poly Haven / ambientCG) — admin Settings UI.
  | 'fab_epic_refresh_token'
  | 'fab_http_proxy'
  | 'fab_flaresolverr_url'
  | 'fab_enabled'
  | 'external_polyhaven_enabled'
  | 'external_ambientcg_enabled'
  | 'external_materials_index_use'
  | 'external_materials_index_providers'
  | 'external_materials_index_updated_at'
  | 'external_materials_index_version'
  // Portal OAuth + Google Workspace (Admin → Settings tiles; consumed by permissions service).
  | 'portal_adapter'
  | 'portal_base_url'
  | 'portal_api_key'
  | 'portal_google_authorize_url'
  | 'portal_mock_persona'
  | 'portal_admin_emails'
  | 'portal_admin_username'
  | 'workspace_adapter'
  | 'workspace_domain'
  | 'workspace_admin_email'
  | 'workspace_enforce_provisioned'
  | 'workspace_grant_all_projects'
  | 'workspace_default_project_level'
  | 'google_oauth_client_id'
  | 'google_oauth_client_secret'
  | 'google_oauth_scopes'
  | 'google_service_account_json'
  | 'google_workspace_directory_refresh_token';

/**
 * Legacy keys that are still read from the DB as a fallback by older code
 * paths (notably `api/workstationDownloads.ts`) but are no longer surfaced
 * in the admin UI as editable. The agent download URL + version are now
 * auto-resolved live from the GitHub Releases API on every request. These
 * union members exist purely to keep existing call sites type-checking
 * until they are removed; do NOT add new keys here.
 */
export type LegacySettingKey =
  | 'workstation_agent_download_url'
  | 'workstation_agent_version';

export async function getSetting(key: SettingKey | LegacySettingKey): Promise<string | undefined> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  const dbVal = rows[0]?.value;
  if (dbVal !== undefined) return dbVal;
  return ENV_FALLBACKS[key];
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(settings);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function isMaintenanceMode(): Promise<boolean> {
  return (await getSetting('maintenance_mode')) === '1';
}
