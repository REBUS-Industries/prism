/**
 * Model library types for the admin SPA. Canonical definitions live in
 * `web/src/shared/api.ts` (alongside `modelsApi`); this module re-exports them
 * under convenient names and adds small client-side helpers.
 *
 * The service-side source of truth is `prism-models-service/src/contracts/models.ts`.
 */
export type {
  ModelVec3 as Vec3,
  ModelBoundingBox as BoundingBox,
  ModelOrigin,
  ModelMediaType,
  ModelMeshRef,
  ModelMaterialSlot,
  ModelTransform,
  ModelLengthUnit,
  ModelDefinition,
  ModelVersionSummary,
  ModelListItem,
  ModelDetail,
} from '../../shared/api';

import type { ModelDefinition } from '../../shared/api';

export function emptyModelDefinition(): ModelDefinition {
  return { meshes: [], materialSlots: [] };
}
