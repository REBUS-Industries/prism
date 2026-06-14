import type { FixtureBeam, FixtureDefinition, FixtureModel, FixturePart } from '../../shared/api';

export interface BeamSpec {
  parentPartId: string;
  lensDiameter: number;
  beamAngle: number;
  zoomMin?: number;
  zoomMax?: number;
}

function partMeta(part: FixturePart): {
  isGeometryReference?: boolean;
  referencedGeometryId?: string;
  isGeometryTemplate?: boolean;
} {
  return (part.metadata ?? {}) as {
    isGeometryReference?: boolean;
    referencedGeometryId?: string;
    isGeometryTemplate?: boolean;
  };
}

function modelDims(model: FixtureModel | undefined): { length: number; width: number } {
  const meta = (model?.metadata ?? {}) as Record<string, unknown>;
  const length = typeof meta.length === 'number' ? meta.length : 0;
  const width = typeof meta.width === 'number' ? meta.width : 0;
  return { length, width };
}

/** First model-bearing part in a geometry subtree (by GDTF geometry name). */
function firstModelPartInGeometry(
  geomId: string,
  parts: FixturePart[],
): FixturePart | undefined {
  const root = parts.find((p) => p.sourceGdtfGeometryId === geomId);
  if (!root) return undefined;
  const stack = [root.partId];
  while (stack.length) {
    const id = stack.pop()!;
    const p = parts.find((x) => x.partId === id);
    if (!p) continue;
    if (p.modelId) return p;
    for (const c of p.childPartIds) stack.push(c);
  }
  return undefined;
}

function lensDiameterForPart(
  partId: string | null | undefined,
  parts: FixturePart[],
  models: FixtureModel[],
): number {
  if (!partId) return 0.08;
  const part = parts.find((p) => p.partId === partId);
  if (!part) return 0.08;

  const modelById = new Map(models.map((m) => [m.modelId, m]));
  let modelId = part.modelId;
  if (!modelId) {
    const meta = partMeta(part);
    if (meta.isGeometryReference && meta.referencedGeometryId) {
      modelId = firstModelPartInGeometry(meta.referencedGeometryId, parts)?.modelId ?? null;
    }
  }
  const dims = modelDims(modelId ? modelById.get(modelId) : undefined);
  return Math.max(dims.length, dims.width) || 0.08;
}

function isTemplatePart(partId: string | null | undefined, parts: FixturePart[]): boolean {
  if (!partId) return false;
  const part = parts.find((p) => p.partId === partId);
  return partMeta(part!).isGeometryTemplate === true;
}

/** Beam is a REBUS emission record (AuraFilament, Wash metadata) — not a cell lens origin. */
function isEmissionMetadataBeam(beam: FixtureBeam, parts: FixturePart[]): boolean {
  const parent = parts.find((p) => p.partId === beam.parentPartId);
  if (!parent) return true;
  if (partMeta(parent).isGeometryTemplate) return true;
  return parent.tag === 'BEAM';
}

/**
 * Build per-lens beam cones for the 3D viewer. Prefers instanced CELL beams (pixel
 * fixtures) over a single LENS/BEAM emission record at the fixture origin.
 */
export function buildFixtureBeamSpecs(
  def: FixtureDefinition,
  options?: {
    visiblePartIds?: Set<string> | null;
    zoomBeamAngle?: number | null;
  },
): BeamSpec[] {
  const parts = def.parts ?? [];
  const models = def.models ?? [];
  const beams = def.beams ?? [];
  const vis = options?.visiblePartIds ?? null;
  const inMode = (id: string | null | undefined): boolean => !vis || (id ? vis.has(id) : true);
  const zoomed = options?.zoomBeamAngle ?? null;

  const primary = beams[0];
  const fallbackAngle = primary?.beamAngle ?? primary?.fieldAngle ?? 20;
  const angleFor = (base: number | undefined): number => zoomed ?? base ?? fallbackAngle;

  const cellBeams = beams.filter((b) => {
    if (!b.parentPartId || !inMode(b.parentPartId)) return false;
    if (isTemplatePart(b.parentPartId, parts)) return false;
    if (isEmissionMetadataBeam(b, parts)) return false;
    const parent = parts.find((p) => p.partId === b.parentPartId);
    return parent?.tag === 'CELL' || partMeta(parent!).isGeometryReference === true;
  });

  if (cellBeams.length) {
    return cellBeams.map((b) => ({
      parentPartId: b.parentPartId!,
      lensDiameter: lensDiameterForPart(b.parentPartId, parts, models),
      beamAngle: angleFor(b.beamAngle ?? b.fieldAngle),
      zoomMin: b.zoomMinAngle,
      zoomMax: b.zoomMaxAngle,
    }));
  }

  // Parser v6 and older may leave beams on the hidden template only — still draw
  // one cone per CELL / GeometryReference instance at its array transform.
  const cellRefs = parts.filter((p) => {
    if (!inMode(p.partId) || partMeta(p).isGeometryTemplate) return false;
    if (p.tag !== 'CELL' && !partMeta(p).isGeometryReference) return false;
    return !beams.some((b) => b.parentPartId === p.partId);
  });
  if (cellRefs.length) {
    return cellRefs.map((p) => ({
      parentPartId: p.partId,
      lensDiameter: lensDiameterForPart(p.partId, parts, models),
      beamAngle: angleFor(fallbackAngle),
    }));
  }

  const emitters = parts.filter(
    (p) => (p.tag === 'LENS' || p.tag === 'CELL') && p.modelId && inMode(p.partId)
      && !partMeta(p).isGeometryTemplate,
  );
  if (emitters.length) {
    return emitters.map((p) => ({
      parentPartId: p.partId,
      lensDiameter: lensDiameterForPart(p.partId, parts, models),
      beamAngle: angleFor(fallbackAngle),
    }));
  }

  return beams
    .filter((b) => b.parentPartId && inMode(b.parentPartId)
      && !isTemplatePart(b.parentPartId, parts)
      && !isEmissionMetadataBeam(b, parts))
    .map((b) => ({
      parentPartId: b.parentPartId!,
      lensDiameter: lensDiameterForPart(b.parentPartId, parts, models),
      beamAngle: angleFor(b.beamAngle ?? b.fieldAngle),
      zoomMin: b.zoomMinAngle,
      zoomMax: b.zoomMaxAngle,
    }));
}
