/**
 * Portal access + connector permissions contracts.
 *
 * Canonical TypeScript source; mirrors `portal-access.json`.
 * Used by prism-permissions-service, PRISM admin UI, and connectors.
 */

export const PORTAL_ACCESS_SCHEMA = 'rebus/portal-access/v1' as const;
export const CONNECTOR_MANIFEST_SCHEMA = 'rebus/connector-manifest/v1' as const;

/** Connector operations that may be gated per project. */
export type ConnectorFunction =
  | 'send'
  | 'receive'
  | 'list_projects'
  | 'list_models'
  | 'list_versions'
  | 'create_project'
  | 'create_model'
  | 'create_version';

export const CONNECTOR_FUNCTIONS: ConnectorFunction[] = [
  'send',
  'receive',
  'list_projects',
  'list_models',
  'list_versions',
  'create_project',
  'create_model',
  'create_version',
];

/** Portal project access level (from REBUS portal API). */
export type PortalProjectLevel = 'viewer' | 'contributor' | 'owner' | 'admin';

export interface PortalUser {
  userId: string;
  email: string;
  googleSub?: string | null;
  displayName?: string | null;
}

export interface PortalProjectPermission {
  orbitProjectId: string;
  level: PortalProjectLevel;
  projectName?: string | null;
}

export interface PortalProjectPermissionsResponse {
  schema: typeof PORTAL_ACCESS_SCHEMA;
  userId: string;
  projects: PortalProjectPermission[];
  fetchedAt: string;
}

/** POST /api/access/session — connector exchanges portal auth code. */
export interface AccessSessionRequest {
  /** OAuth-style code from portal callback (mock accepts `mock:` prefix). */
  portalAuthCode: string;
  /** ORBIT target for token minting. */
  orbitTarget?: 'prod' | 'dev';
  /** Optional redirect URI used in portal OAuth (must match registration). */
  redirectUri?: string;
}

export interface ConnectorManifestProject {
  orbitProjectId: string;
  projectName?: string | null;
  level: PortalProjectLevel;
  /** Allowed connector functions for this project (effective = portal ∩ policy graph). */
  allowedFunctions: ConnectorFunction[];
}

/** Returned to connectors after portal-brokered login. */
export interface ConnectorManifest {
  schema: typeof CONNECTOR_MANIFEST_SCHEMA;
  userId: string;
  email: string;
  displayName?: string | null;
  orbitTarget: 'prod' | 'dev';
  orbitServerUrl: string;
  /** Scoped ORBIT bearer token — use for all ORBIT API calls. */
  orbitToken: string;
  /** Token expiry (ISO); connector should re-auth before this. */
  expiresAt: string;
  /** Session id for manifest refresh via GET /api/access/manifest. */
  sessionId: string;
  projects: ConnectorManifestProject[];
  /** Global defaults when project-specific list is empty. */
  globalAllowedFunctions: ConnectorFunction[];
}

export interface AccessSessionResponse {
  manifest: ConnectorManifest;
}

/** Node graph policy (admin permissions editor). */
export type PolicyNodeType = 'role' | 'user' | 'project' | 'function';

export interface PolicyNode {
  id: string;
  type: PolicyNodeType;
  label: string;
  /** role name, user email, orbit project id, or function id */
  ref?: string | null;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
}

export interface PolicyEdge {
  id: string;
  source: string;
  target: string;
  /** When set, edge grants the target function to source principal for project ref on target node. */
  grant?: boolean;
}

export interface FunctionPolicyGraph {
  nodes: PolicyNode[];
  edges: PolicyEdge[];
  updatedAt?: string;
}

export interface PermissionsPolicyResponse {
  graph: FunctionPolicyGraph;
  defaultFunctions: ConnectorFunction[];
}

/** Service-side portal integration (implemented in prism-permissions-service). */
export interface PortalAdapterConfig {
  baseUrl: string;
  apiKey?: string;
  cacheTtlMs: number;
}

export interface PortalAdapter {
  exchangeAuthCode(code: string, redirectUri?: string): Promise<string>;
  getMe(portalToken: string): Promise<PortalUser>;
  getProjectPermissions(portalToken: string, userId: string): Promise<PortalProjectPermissionsResponse>;
}

// ── Google Workspace linking + pre-provisioned users ─────────────────────────

export type GoogleWorkspaceStatus = 'disconnected' | 'linked' | 'syncing';

export interface GoogleWorkspaceLink {
  id: string;
  domain: string;
  displayName?: string | null;
  status: GoogleWorkspaceStatus;
  /** mock | google_admin_sdk */
  adapter: string;
  linkedAt?: string | null;
  lastSyncAt?: string | null;
  userCount: number;
}

export type ProvisionedUserStatus = 'pending' | 'active' | 'suspended';
export type ProvisionedUserSource = 'manual' | 'workspace_sync';

export interface ProvisionedUser {
  id: string;
  email: string;
  displayName?: string | null;
  googleSub?: string | null;
  status: ProvisionedUserStatus;
  source: ProvisionedUserSource;
  /** Grant PRISM admin SPA access on Google sign-in. */
  isPrismAdmin: boolean;
  /** Optional bind to local admin_users.username (defaults to PORTAL_ADMIN_USERNAME). */
  prismAdminUsername?: string | null;
  /** Pre-defined ORBIT project access (applied before first login). */
  projectPermissions: PortalProjectPermission[];
  /** Role refs matched against function-policy graph role nodes. */
  roleRefs: string[];
  lastLoginAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSyncResult {
  linked: GoogleWorkspaceLink;
  imported: number;
  updated: number;
  unchanged: number;
}

export interface ProvisionedUserInput {
  email: string;
  displayName?: string | null;
  isPrismAdmin?: boolean;
  prismAdminUsername?: string | null;
  projectPermissions?: PortalProjectPermission[];
  roleRefs?: string[];
  status?: ProvisionedUserStatus;
}

export interface ProvisionedAdminCheck {
  allowed: boolean;
  prismAdminUsername?: string | null;
  email: string;
}
