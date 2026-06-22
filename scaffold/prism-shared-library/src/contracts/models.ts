/**
 * Prism model library wire types.
 * Canonical source — sync PRISM/web/src/shared/api.ts on change.
 */

export type ModelOrigin = 'upload' | 'import' | 'manual';
export type ModelImportStatus = 'converting' | 'complete' | 'failed';

export interface ModelVec3 {
  x: number;
  y: number;
  z: number;
}

export interface ModelBoundingBox {
  min: ModelVec3;
  max: ModelVec3;
}

/** Orbit storage reference for a model definition (Model Library Project). */
export interface ModelOrbitRef {
  target: 'prod' | 'dev';
  projectId: string;
  modelId: string;
  versionId?: string;
  resultUrl?: string;
}

export interface ModelMeshRef {
  mediaId: string;
  name: string;
  lod?: number;
  format?: 'glb';
}

export type ModelMaterialSlotKind = 'mesh' | 'sourceMaterial';

export interface ModelMaterialSlot {
  name: string;
  materialId?: string | null;
  kind?: ModelMaterialSlotKind;
}

export type ModelLengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export interface ModelTransform {
  position: ModelVec3;
  rotation: ModelVec3;
  scale: ModelVec3;
}

export interface ModelDefinition {
  meshes: ModelMeshRef[];
  materialSlots: ModelMaterialSlot[];
  boundingBox?: ModelBoundingBox;
  dimensions?: { length: number; width: number; height: number };
  upAxis?: 'Y' | 'Z';
  transform?: ModelTransform;
  sourceUnits?: ModelLengthUnit;
  metadata?: Record<string, unknown>;
}

export interface ModelVersionSummary {
  id: string;
  sourceHash: string | null;
  /** When the version row was created / import completed. */
  createdAt: string;
  isActive: boolean;
  /** Relative preview path — active version uses `/preview.glb`, others use `/media/{id}`. */
  previewUrl: string | null;
  /** Orbit viewer URL when this version carries an Orbit ref in its definition snapshot. */
  orbitUrl: string | null;
}

export interface ModelTypeSummary {
  id: string;
  name: string;
  category: string | null;
  tags: string[];
  status: 'draft' | 'published';
  origin: ModelOrigin;
  description: string | null;
  activeVersionId: string | null;
  hasPreview: boolean;
  importStatus?: ModelImportStatus | null;
  importJobId?: string | null;
  /** Relative preview path for the active version (`GET …/preview.glb` or media URL). */
  previewUrl: string | null;
  /** Orbit viewer URL from `definition.metadata.orbit` when present. */
  orbitUrl: string | null;
  /** Stored revision history with per-version preview + Orbit links. */
  versions: ModelVersionSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface ModelTypeDetail extends ModelTypeSummary {
  definition: ModelDefinition;
  dimensions: { length: number; width: number; height: number } | null;
  boundingBox: ModelBoundingBox | null;
}
