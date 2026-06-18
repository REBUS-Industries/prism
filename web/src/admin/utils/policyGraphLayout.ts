import type { PolicyNodeType } from '../../shared/api';

export interface PolicyNodeData {
  policyType: PolicyNodeType;
  label: string;
  refValue?: string | null;
  /** Hide left target handle (e.g. role column roots). */
  noTarget?: boolean;
  /** Hide right source handle (e.g. tool column leaves). */
  noSource?: boolean;
  /** Role has grants but is no longer in the portal's live role list. */
  stale?: boolean;
}

export interface PolicyFlowNode {
  id: string;
  type: 'policy';
  position: { x: number; y: number };
  data: PolicyNodeData;
}

export interface PolicyFlowEdge {
  id: string;
  source: string;
  target: string;
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
