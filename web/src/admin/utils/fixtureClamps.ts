/**
 * Multi-clamp helpers for the fixture editor.
 *
 * Each REBUS clamp is a top-level CLAMP part (`metadata.rebusSlot`) that shares
 * the `rebus-clamp` model (upload or Model Library). Position / rotation live on
 * `part.localTransform` and are edited in the Parts properties panel — not via
 * the legacy global mirror/rotate metadata.
 */
import type { FixtureDefinition, FixtureModel, FixturePart } from '../../shared/api';
import { buildTransform4x4 } from './fixtureTransform';
import {
  REBUS_CLAMP_MODEL_ID,
  REBUS_CLAMP_PART_ID,
  readClampPlacement,
} from './fixturePlacement';

const IDENTITY_MATRIX = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
] as const;

export function isRebusClampPart(part: FixturePart | null | undefined): boolean {
  if (!part) return false;
  if (part.partId === REBUS_CLAMP_PART_ID) return true;
  return part.tag === 'CLAMP'
    && (part.metadata as { rebusSlot?: unknown } | undefined)?.rebusSlot === true;
}

export function listRebusClampParts(definition: FixtureDefinition): FixturePart[] {
  return (definition.parts ?? []).filter((p) => isRebusClampPart(p));
}

/** Ensure the shared clamp model row exists (does not force a part). */
export function ensureRebusClampModel(definition: FixtureDefinition): FixtureModel {
  let model = definition.models.find((m) => m.modelId === REBUS_CLAMP_MODEL_ID);
  if (!model) {
    model = {
      modelId: REBUS_CLAMP_MODEL_ID,
      partTag: 'CLAMP',
      assignedPartIds: [],
      metadata: { rebusSlot: true },
    };
    definition.models.push(model);
  }
  if (!model.metadata || typeof model.metadata !== 'object') model.metadata = { rebusSlot: true };
  (model.metadata as Record<string, unknown>).rebusSlot = true;
  return model;
}

function nextClampPartId(parts: FixturePart[]): string {
  if (!parts.some((p) => p.partId === REBUS_CLAMP_PART_ID)) return REBUS_CLAMP_PART_ID;
  let n = 2;
  while (parts.some((p) => p.partId === `rebus-clamp-part-${n}`)) n += 1;
  return `rebus-clamp-part-${n}`;
}

function nextClampName(parts: FixturePart[]): string {
  const clamps = parts.filter((p) => isRebusClampPart(p));
  if (clamps.length === 0) return 'Clamp';
  return `Clamp ${clamps.length + 1}`;
}

function makeClampPart(partId: string, name: string): FixturePart {
  return {
    partId,
    sourceGdtfGeometryId: 'Clamp',
    name,
    tag: 'CLAMP',
    parentPartId: null,
    childPartIds: [],
    modelId: REBUS_CLAMP_MODEL_ID,
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

/** Add another clamp part sharing the rebus-clamp model. Returns the new part. */
export function addRebusClampPart(definition: FixtureDefinition): FixturePart {
  const model = ensureRebusClampModel(definition);
  const partId = nextClampPartId(definition.parts);
  const part = makeClampPart(partId, nextClampName(definition.parts));
  definition.parts.push(part);
  if (!model.assignedPartIds.includes(partId)) {
    model.assignedPartIds = [...model.assignedPartIds, partId];
  }
  return part;
}

/**
 * Remove a rebus clamp part. Returns true when removed. Clears the shared model
 * assignment; leaves the model row (upload / library media) intact for siblings.
 */
export function removeRebusClampPart(
  definition: FixtureDefinition,
  partId: string,
): boolean {
  const part = definition.parts.find((p) => p.partId === partId);
  if (!part || !isRebusClampPart(part)) return false;

  definition.parts = definition.parts.filter((p) => p.partId !== partId);
  const model = definition.models.find((m) => m.modelId === REBUS_CLAMP_MODEL_ID);
  if (model) {
    model.assignedPartIds = model.assignedPartIds.filter((id) => id !== partId);
  }
  // Drop parent→child refs that pointed at the removed clamp (rare).
  for (const p of definition.parts) {
    if (p.childPartIds?.includes(partId)) {
      p.childPartIds = p.childPartIds.filter((id) => id !== partId);
    }
  }
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

  ensureRebusClampModel(definition);
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
    const mirror = addRebusClampPart(definition);
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

/** @deprecated kept for type imports that still reference identity matrix helpers */
export const CLAMP_IDENTITY_MATRIX = IDENTITY_MATRIX;
