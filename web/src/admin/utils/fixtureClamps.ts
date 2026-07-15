/**
 * Multi-clamp helpers for the fixture editor.
 *
 * Each REBUS clamp is a top-level CLAMP part (`metadata.rebusSlot`) with its own
 * model row (`rebus-clamp`, `rebus-clamp-2`, …). Mesh source is per instance:
 * upload onto that model, or `model.metadata.clampModelLibraryId` (Model Library).
 * Position / rotation live on `part.localTransform` (Parts panel).
 */
import type { FixtureDefinition, FixtureModel, FixturePart } from '../../shared/api';
import { buildTransform4x4 } from './fixtureTransform';
import {
  REBUS_CLAMP_MODEL_ID,
  REBUS_CLAMP_PART_ID,
  readClampModelLibraryId,
  readClampPlacement,
} from './fixturePlacement';

export function isRebusClampPart(part: FixturePart | null | undefined): boolean {
  if (!part) return false;
  if (part.partId === REBUS_CLAMP_PART_ID) return true;
  if (part.partId.startsWith('rebus-clamp-part-')) return true;
  return part.tag === 'CLAMP'
    && (part.metadata as { rebusSlot?: unknown } | undefined)?.rebusSlot === true;
}

export function isRebusClampModel(model: FixtureModel | null | undefined): boolean {
  if (!model) return false;
  if (model.modelId === REBUS_CLAMP_MODEL_ID) return true;
  if (model.modelId.startsWith('rebus-clamp-')) return true;
  return model.partTag === 'CLAMP'
    && (model.metadata as { rebusSlot?: unknown } | undefined)?.rebusSlot === true;
}

export function listRebusClampParts(definition: FixtureDefinition): FixturePart[] {
  return (definition.parts ?? []).filter((p) => isRebusClampPart(p));
}

/** Model Library id stored on a clamp model (per-instance). */
export function readClampLibraryIdFromModel(
  model: FixtureModel | null | undefined,
): string | null {
  const meta = model?.metadata as { clampModelLibraryId?: unknown } | undefined;
  const id = meta?.clampModelLibraryId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function writeClampLibraryIdToModel(
  model: FixtureModel,
  libraryId: string | null,
): void {
  if (!model.metadata || typeof model.metadata !== 'object') model.metadata = {};
  const meta = model.metadata as Record<string, unknown>;
  if (libraryId) meta.clampModelLibraryId = libraryId;
  else delete meta.clampModelLibraryId;
}

function nextClampPartId(parts: FixturePart[]): string {
  if (!parts.some((p) => p.partId === REBUS_CLAMP_PART_ID)) return REBUS_CLAMP_PART_ID;
  let n = 2;
  while (parts.some((p) => p.partId === `rebus-clamp-part-${n}`)) n += 1;
  return `rebus-clamp-part-${n}`;
}

function nextClampModelId(models: FixtureModel[]): string {
  if (!models.some((m) => m.modelId === REBUS_CLAMP_MODEL_ID)) return REBUS_CLAMP_MODEL_ID;
  let n = 2;
  while (models.some((m) => m.modelId === `rebus-clamp-${n}`)) n += 1;
  return `rebus-clamp-${n}`;
}

function nextClampName(parts: FixturePart[]): string {
  const clamps = parts.filter((p) => isRebusClampPart(p));
  if (clamps.length === 0) return 'Clamp';
  return `Clamp ${clamps.length + 1}`;
}

function makeClampModel(modelId: string, partId: string, libraryId?: string | null): FixtureModel {
  const metadata: Record<string, unknown> = { rebusSlot: true };
  if (libraryId) metadata.clampModelLibraryId = libraryId;
  return {
    modelId,
    partTag: 'CLAMP',
    assignedPartIds: [partId],
    metadata,
  };
}

function makeClampPart(partId: string, name: string, modelId: string): FixturePart {
  return {
    partId,
    sourceGdtfGeometryId: 'Clamp',
    name,
    tag: 'CLAMP',
    parentPartId: null,
    childPartIds: [],
    modelId,
    materialId: null,
    localTransform: buildTransform4x4(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    ),
    pivot: { x: 0, y: 0, z: 0 },
    motionAxisId: null,
    metadata: { rebusSlot: true },
  };
}

export interface AddClampOptions {
  /** Model Library id to bind for viewport preview (optional). */
  libraryModelId?: string | null;
}

/**
 * Add a clamp instance with its own model row. Returns the new part (and model).
 */
export function addRebusClampPart(
  definition: FixtureDefinition,
  options: AddClampOptions = {},
): { part: FixturePart; model: FixtureModel } {
  const partId = nextClampPartId(definition.parts);
  const modelId = nextClampModelId(definition.models);
  const model = makeClampModel(modelId, partId, options.libraryModelId ?? null);
  const part = makeClampPart(partId, nextClampName(definition.parts), modelId);
  definition.models.push(model);
  definition.parts.push(part);
  return { part, model };
}

/**
 * If `part` shares its model with other clamps, fork a dedicated model for this
 * part (copy metadata) so mesh changes stay instance-local.
 */
export function ensureDedicatedClampModel(
  definition: FixtureDefinition,
  partId: string,
): FixtureModel | null {
  const part = definition.parts.find((p) => p.partId === partId);
  if (!part || !isRebusClampPart(part) || !part.modelId) return null;
  const model = definition.models.find((m) => m.modelId === part.modelId);
  if (!model) return null;

  const siblings = (model.assignedPartIds ?? []).filter((id) => id !== partId);
  const otherUsers = definition.parts.filter(
    (p) => p.partId !== partId && p.modelId === model.modelId,
  );
  if (siblings.length === 0 && otherUsers.length === 0) {
    if (!model.assignedPartIds.includes(partId)) {
      model.assignedPartIds = [...model.assignedPartIds, partId];
    }
    return model;
  }

  const newModelId = nextClampModelId(definition.models);
  const forked: FixtureModel = {
    modelId: newModelId,
    partTag: 'CLAMP',
    assignedPartIds: [partId],
    sourceFile: model.sourceFile,
    sourceGdtfModel: model.sourceGdtfModel,
    metadata: {
      ...(typeof model.metadata === 'object' && model.metadata ? { ...model.metadata } : {}),
      rebusSlot: true,
    },
  };
  definition.models.push(forked);
  model.assignedPartIds = model.assignedPartIds.filter((id) => id !== partId);
  part.modelId = newModelId;
  return forked;
}

/**
 * Remove a rebus clamp part and its dedicated model when unused.
 */
export function removeRebusClampPart(
  definition: FixtureDefinition,
  partId: string,
): boolean {
  const part = definition.parts.find((p) => p.partId === partId);
  if (!part || !isRebusClampPart(part)) return false;
  const modelId = part.modelId;

  definition.parts = definition.parts.filter((p) => p.partId !== partId);
  if (modelId) {
    const model = definition.models.find((m) => m.modelId === modelId);
    if (model) {
      model.assignedPartIds = model.assignedPartIds.filter((id) => id !== partId);
      const stillUsed = definition.parts.some((p) => p.modelId === modelId);
      if (!stillUsed && isRebusClampModel(model)) {
        definition.models = definition.models.filter((m) => m.modelId !== modelId);
      }
    }
  }
  for (const p of definition.parts) {
    if (p.childPartIds?.includes(partId)) {
      p.childPartIds = p.childPartIds.filter((id) => id !== partId);
    }
  }
  return true;
}

/**
 * Copy legacy fixture-level `clampModelLibraryId` onto each clamp model, then clear it.
 */
export function migrateLegacyClampLibraryId(definition: FixtureDefinition): boolean {
  const meta = (definition.metadata ?? {}) as Record<string, unknown>;
  const legacyId = readClampModelLibraryId(meta);
  if (!legacyId) return false;

  const clamps = listRebusClampParts(definition);
  for (const part of clamps) {
    const model = part.modelId
      ? definition.models.find((m) => m.modelId === part.modelId)
      : undefined;
    if (!model) continue;
    if (!readClampLibraryIdFromModel(model)) {
      writeClampLibraryIdToModel(model, legacyId);
    }
  }

  delete meta.clampModelLibraryId;
  definition.metadata = meta;
  return true;
}

/**
 * Expand legacy `clampMirrorZ` / `clampRotateZDeg` metadata into real clamp
 * parts with localTransforms, then clear the legacy flags. Idempotent.
 */
export function migrateLegacyClampPlacement(definition: FixtureDefinition): boolean {
  const meta = (definition.metadata ?? {}) as Record<string, unknown>;
  const placement = readClampPlacement(meta);
  const hasLegacy = placement.mirrorZ
    || placement.rotateZDeg !== 0
    || meta.clampMirrorZ === true
    || meta.clampMirrorY === true
    || typeof meta.clampRotateZDeg === 'number';
  if (!hasLegacy) return false;

  let clamps = listRebusClampParts(definition);
  if (clamps.length === 0) {
    addRebusClampPart(definition);
    clamps = listRebusClampParts(definition);
  }

  const primary = clamps[0]!;
  const t = primary.localTransform;
  const pos = t?.position ?? { x: 0, y: 0, z: 0 };
  const rot = t?.rotation ?? { x: 0, y: 0, z: 0 };
  const scale = t?.scale ?? { x: 1, y: 1, z: 1 };
  primary.localTransform = buildTransform4x4(
    { ...pos },
    { ...rot, z: rot.z + placement.rotateZDeg },
    { ...scale },
  );

  if (placement.mirrorZ && clamps.length === 1) {
    const { part: mirror } = addRebusClampPart(definition);
    // Share the primary's model so both use the same mesh until the user forks.
    const primaryModelId = primary.modelId;
    if (primaryModelId) {
      const shared = definition.models.find((m) => m.modelId === primaryModelId);
      if (shared) {
        // Drop the dedicated model created by addRebusClampPart.
        definition.models = definition.models.filter((m) => m.modelId !== mirror.modelId);
        mirror.modelId = primaryModelId;
        if (!shared.assignedPartIds.includes(mirror.partId)) {
          shared.assignedPartIds = [...shared.assignedPartIds, mirror.partId];
        }
      }
    }
    mirror.name = `${primary.name || 'Clamp'} (mirror)`;
    mirror.localTransform = buildTransform4x4(
      { ...pos },
      { ...rot, z: rot.z + placement.rotateZDeg },
      { x: scale.x, y: scale.y, z: -Math.abs(scale.z || 1) },
    );
  } else if (placement.rotateZDeg !== 0) {
    for (const c of clamps.slice(1)) {
      const ct = c.localTransform;
      const cpos = ct?.position ?? { x: 0, y: 0, z: 0 };
      const crot = ct?.rotation ?? { x: 0, y: 0, z: 0 };
      const cscale = ct?.scale ?? { x: 1, y: 1, z: 1 };
      c.localTransform = buildTransform4x4(
        { ...cpos },
        { ...crot, z: crot.z + placement.rotateZDeg },
        { ...cscale },
      );
    }
  }

  delete meta.clampMirrorZ;
  delete meta.clampMirrorY;
  delete meta.clampRotateZDeg;
  definition.metadata = meta;
  return true;
}

/** Human-readable mesh label for a clamp instance row. */
export function clampMeshLabel(
  part: FixturePart,
  models: FixtureModel[],
  libraryName?: string | null,
): string {
  const model = part.modelId ? models.find((m) => m.modelId === part.modelId) : undefined;
  const libId = readClampLibraryIdFromModel(model);
  if (libId) return libraryName?.trim() || `Library model`;
  const meta = model?.metadata as { replaced?: unknown; replacedFilename?: unknown; mediaId?: unknown } | undefined;
  if (meta?.replaced === true) {
    return typeof meta.replacedFilename === 'string' && meta.replacedFilename
      ? meta.replacedFilename
      : 'Custom mesh';
  }
  if (typeof meta?.mediaId === 'string' && meta.mediaId) return 'Uploaded mesh';
  return 'No mesh';
}
