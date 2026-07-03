import type { FixtureModel } from '../../shared/api';
import { fixturesApi } from '../../shared/api';
import { getModelMediaId } from './fixtureAssembly';
import { box3FromGdtfBounds, readGdtfBounds } from './fixtureGdtfBounds';
import { loadModelBoundsFromUrl } from './fixtureModelBounds';
import {
  alignOffset,
  DEFAULT_BBOX_ANCHORS,
  type BboxAnchors,
} from './fixtureMeshAlign';
import { readMeshOffset, writeMeshOffset, type MeshOffset } from './fixtureTransform';

/** When true, mesh offset is derived from GDTF vs custom mesh bbox alignment (not file origin). */
export function readIgnoreImportedMeshDatum(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return (metadata ?? {}).ignoreImportedMeshDatum === true;
}

export function writeIgnoreImportedMeshDatum(
  metadata: Record<string, unknown>,
  enabled: boolean,
): void {
  if (enabled) metadata.ignoreImportedMeshDatum = true;
  else delete metadata.ignoreImportedMeshDatum;
}

/** Compute mesh-offset translation that maps custom mesh bbox anchors onto stored GDTF bounds. */
export async function computeMeshOffsetFromGdtfBounds(
  fixtureId: string,
  model: FixtureModel,
  anchors: BboxAnchors = DEFAULT_BBOX_ANCHORS,
): Promise<MeshOffset | null> {
  const gdtfBounds = readGdtfBounds(model.metadata as Record<string, unknown>);
  if (!gdtfBounds) return null;

  const mediaId = getModelMediaId(model);
  if (!mediaId) return null;

  const customBox = await loadModelBoundsFromUrl(
    fixturesApi.mediaUrl(fixtureId, mediaId),
    model,
    true,
  );
  if (!customBox || customBox.isEmpty()) return null;

  const gdtfBox = box3FromGdtfBounds(gdtfBounds);
  const position = alignOffset(gdtfBox, customBox, anchors);
  return { position, rotation: { x: 0, y: 0, z: 0 } };
}

/** Apply bbox alignment into model.metadata.meshOffset (custom meshes: translation only). */
export async function applyIgnoreImportedMeshDatum(
  fixtureId: string,
  model: FixtureModel,
  anchors: BboxAnchors = DEFAULT_BBOX_ANCHORS,
): Promise<boolean> {
  const offset = await computeMeshOffsetFromGdtfBounds(fixtureId, model, anchors);
  if (!offset) return false;
  if (!model.metadata || typeof model.metadata !== 'object') model.metadata = {};
  writeMeshOffset(model.metadata as Record<string, unknown>, offset);
  return true;
}

/** Clear ignore-datum mode and remove any mesh-offset translation. */
export function clearIgnoreImportedMeshDatum(model: FixtureModel): void {
  if (!model.metadata || typeof model.metadata !== 'object') return;
  const meta = model.metadata as Record<string, unknown>;
  writeIgnoreImportedMeshDatum(meta, false);
  delete meta.meshOffset;
}
