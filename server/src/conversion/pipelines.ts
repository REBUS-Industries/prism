/**
 * Pipeline DAG declarations.
 *
 * Both the job dispatcher (server-side: decides which stages run) and
 * the admin SPA flow editor (client-side: draws the nodes) read from
 * this file. Editing the DAG here is the only way to change the visible
 * pipeline.
 *
 * Phase 5 fills in the live overlays. Phase 1 only needs this typed so
 * the dispatcher can iterate stages in order.
 */

export type StageKind =
  | 'ingest'        // accept the upload, persist metadata
  | 'validate'     // check format, size, ORBIT target reachable
  | 'layerInspect' // optional: open the file just to read layer tree
  | 'queue'         // BullMQ enqueue
  | 'dispatch'    // pick an eligible agent slot
  | 'workstation'   // Rhino opens + converts
  | 'upload'      // agent pushes ORBIT objects + blobs
  | 'preview'      // optional: generate GLB preview
  | 'notify'       // mark job complete, fire admin WS event
  | 'webhook';      // optional: POST callback url

export interface Stage {
  id: string;
  kind: StageKind;
  label: string;
  optional: boolean;
  description: string;
}

export interface Pipeline {
  id: string;
  label: string;
  stages: Stage[];
  edges: Array<[fromId: string, toId: string]>;
}

export const DEFAULT_PIPELINE: Pipeline = {
  id: 'default',
  label: 'Default conversion pipeline',
  stages: [
    { id: 'ingest',       kind: 'ingest',       label: 'Ingest',         optional: false, description: 'Accept upload, persist job row' },
    { id: 'validate',     kind: 'validate',     label: 'Validate',       optional: false, description: 'Format + size + ORBIT target check' },
    { id: 'layerInspect', kind: 'layerInspect', label: 'Layer inspect',  optional: true,  description: 'Open file once to list layers (skipped if no layer filter)' },
    { id: 'queue',        kind: 'queue',        label: 'Queue',          optional: false, description: 'BullMQ enqueue' },
    { id: 'dispatch',     kind: 'dispatch',     label: 'Dispatch',       optional: false, description: 'Pick an eligible idle agent slot' },
    { id: 'workstation',  kind: 'workstation',  label: 'Workstation',    optional: false, description: 'Rhino opens the file and converts' },
    { id: 'upload',       kind: 'upload',       label: 'Upload to ORBIT', optional: false, description: 'Agent pushes objects + blobs to orbit-server' },
    { id: 'preview',      kind: 'preview',      label: 'GLB preview',    optional: true,  description: 'Generate preview thumbnail (optional)' },
    { id: 'notify',       kind: 'notify',       label: 'Notify',         optional: false, description: 'Mark complete, fan out events' },
    { id: 'webhook',      kind: 'webhook',      label: 'Webhook',        optional: true,  description: 'POST callback url if the job specified one' },
  ],
  edges: [
    ['ingest',       'validate'],
    ['validate',     'layerInspect'],
    ['layerInspect', 'queue'],
    ['validate',     'queue'],          // when layerInspect is skipped
    ['queue',        'dispatch'],
    ['dispatch',     'workstation'],
    ['workstation',  'upload'],
    ['upload',       'preview'],
    ['upload',       'notify'],         // when preview is skipped
    ['preview',      'notify'],
    ['notify',       'webhook'],        // optional fan-out
  ],
};
