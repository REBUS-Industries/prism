import type { ConnectorFunction, InviteModelAccess, PolicyNodeType } from '../../shared/api';

/** Guest invite-key metadata attached to user nodes on the Permissions graph. */
export interface GuestInviteNodeMeta {
  inviteKeyId?: string | null;
  orbitTarget: 'prod' | 'dev';
  allowedFunctions: ConnectorFunction[];
  maxRedemptions?: number | null;
  expiresAt?: string | null;
  redemptionCount?: number;
  revoked?: boolean;
  dirty?: boolean;
  /** Plaintext key — only present immediately after create. */
  plaintextKey?: string | null;
  redeemUrl?: string | null;
  /** Model visibility for Connector Light. */
  modelAccess?: InviteModelAccess;
  /** When modelAccess is `selected`. */
  selectedModelIds?: string[];
}

/** Google Workspace / provisioned-user metadata on the Permissions graph. */
export interface WorkspaceUserNodeMeta {
  provisionedUserId: string;
  email: string;
  status: string;
  source: 'manual' | 'workspace_sync';
  isPrismAdmin: boolean;
  /** Project edges currently stored on the provisioned user in Prism. */
  projectCount: number;
}

export interface PolicyNodeData {
  policyType: PolicyNodeType;
  label: string;
  refValue?: string | null;
  /** Hide left target handle (e.g. role column roots). */
  noTarget?: boolean;
  /** Hide right source handle (e.g. tool column leaves). */
  noSource?: boolean;
  /**
   * Side for the source handle. Defaults to right (left-to-right graphs).
   * Guests on the right of Projects use `left` so wires face the middle column.
   */
  sourceSide?: 'left' | 'right';
  /**
   * Show an extra target handle on the right (projects receiving edges from a
   * column to their right, e.g. Guests).
   */
  targetRight?: boolean;
  /** Role has grants but is no longer in the portal's live role list. */
  stale?: boolean;
  /** True when this user node is a Connector Light guest invite key. */
  guest?: boolean;
  guestMeta?: GuestInviteNodeMeta;
  /** True when this user node is a Google Workspace / provisioned user. */
  workspaceUser?: boolean;
  workspaceMeta?: WorkspaceUserNodeMeta;
}

export interface PolicyFlowNode {
  id: string;
  type: 'policy';
  position: { x: number; y: number };
  data: PolicyNodeData;
  /** Vue Flow selection flag (lasso / multi-select). */
  selected?: boolean;
}

export interface PolicyFlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  markerEnd?: string;
  animated?: boolean;
}

/** Lightweight flow node shape used by ToolAccess to avoid vue-flow generic depth limits. */
export interface ToolFlowNode {
  id: string;
  label?: string;
  position: { x: number; y: number };
  data: PolicyNodeData;
}

/** Pin-board column X positions — mirrors portal PeopleManagementClient layout. */
export const POLICY_COLUMN_X: Record<PolicyNodeType, number> = {
  role: 80,
  user: 300,
  project: 520,
  function: 740,
  tool: 520,
};

/**
 * Access graph (Permissions) column X — wider than POLICY_COLUMN_X so workspace
 * → project → guest edges have room to read. Nodes are ~220px wide.
 */
export const ACCESS_COLUMN_X = {
  workspace: 80,
  project: 520,
  guest: 960,
} as const;

export function policyColumnPosition(type: PolicyNodeType, indexInColumn: number): { x: number; y: number } {
  return {
    x: POLICY_COLUMN_X[type] ?? 120,
    y: 80 + indexInColumn * 72,
  };
}

export function policyNodeTypeLabel(type: PolicyNodeType): string {
  switch (type) {
    case 'role': return 'Role';
    case 'user': return 'User';
    case 'project': return 'Project';
    case 'function': return 'Function';
    case 'tool': return 'Tool';
    default: return type;
  }
}
