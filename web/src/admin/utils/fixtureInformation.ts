import type { FixtureDefinition, FixtureModel, FixturePart } from '../../shared/api';

export interface FixtureInfoParam {
  label: string;
  value: string;
}

type FixtureInfo = FixtureDefinition['fixtureInformation'];

const dash = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return '—';
  return String(v);
};

const fmtNum = (n: number | undefined, digits = 2): string => {
  if (n === undefined || Number.isNaN(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/\.?0+$/, '');
};

const mm = (m: number | undefined): string =>
  m !== undefined && m > 0 ? `${fmtNum(m * 1000, 1)} mm` : '—';

function multiply4x4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      out[row * 4 + col] =
        a[row * 4 + 0]! * b[0 * 4 + col]!
        + a[row * 4 + 1]! * b[1 * 4 + col]!
        + a[row * 4 + 2]! * b[2 * 4 + col]!
        + a[row * 4 + 3]! * b[3 * 4 + col]!;
    }
  }
  return out;
}

/** Recompute overall L×W×H from geometry + model dims when import omitted them. */
export function computeOverallDimensionsFromDefinition(
  parts: FixturePart[],
  models: FixtureModel[],
): { lengthM: number; widthM: number; heightM: number } | undefined {
  const modelById = new Map(models.map((m) => [m.modelId, m]));
  const byId = new Map(parts.map((p) => [p.partId, p]));
  const world = new Map<string, number[]>();

  const worldM = (partId: string): number[] => {
    const cached = world.get(partId);
    if (cached) return cached;
    const part = byId.get(partId)!;
    const local = part.localTransform.matrix4x4;
    const m = part.parentPartId
      ? multiply4x4(worldM(part.parentPartId), local)
      : local;
    world.set(partId, m);
    return m;
  };

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;

  for (const part of parts) {
    if (!part.modelId) continue;
    const model = modelById.get(part.modelId);
    const meta = (model?.metadata ?? {}) as Record<string, unknown>;
    const l = typeof meta.length === 'number' ? meta.length : 0;
    const w = typeof meta.width === 'number' ? meta.width : 0;
    const h = typeof meta.height === 'number' ? meta.height : 0;
    if (l <= 0 || w <= 0 || h <= 0) continue;

    const m = worldM(part.partId);
    const hx = l / 2, hy = w / 2, hz = h / 2;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const px = sx * hx, py = sy * hy, pz = sz * hz;
          const x = m[0]! * px + m[4]! * py + m[8]! * pz + m[3]!;
          const y = m[1]! * px + m[5]! * py + m[9]! * pz + m[7]!;
          const z = m[2]! * px + m[6]! * py + m[10]! * pz + m[11]!;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          any = true;
        }
      }
    }
  }

  if (!any) return undefined;
  return { lengthM: maxX - minX, widthM: maxY - minY, heightM: maxZ - minZ };
}

/** Inspector / overview rows for the full GDTF fixture information block. */
export function fixtureInformationParams(
  info: FixtureInfo,
  parts: FixturePart[] = [],
  models: FixtureModel[] = [],
): FixtureInfoParam[] {
  const ext = info as FixtureInfo & {
    shortName?: string;
    weightKg?: number;
    legHeightM?: number;
    operatingTempLowC?: number;
    operatingTempHighC?: number;
    powerConsumptionW?: number;
    powerDetails?: string;
    overallLengthM?: number;
    overallWidthM?: number;
    overallHeightM?: number;
  };

  const overall = ext.overallLengthM && ext.overallWidthM && ext.overallHeightM
    ? { lengthM: ext.overallLengthM, widthM: ext.overallWidthM, heightM: ext.overallHeightM }
    : computeOverallDimensionsFromDefinition(parts, models);

  const tempRange = ext.operatingTempLowC !== undefined && ext.operatingTempHighC !== undefined
    ? `${fmtNum(ext.operatingTempLowC, 0)} … ${fmtNum(ext.operatingTempHighC, 0)} °C`
    : '—';

  const power = ext.powerDetails
    ?? (ext.powerConsumptionW !== undefined && ext.powerConsumptionW > 0
      ? `${fmtNum(ext.powerConsumptionW, 0)} W`
      : '—');

  const rows: FixtureInfoParam[] = [
    { label: 'Manufacturer', value: dash(ext.manufacturer) },
    { label: 'Name', value: dash(ext.fixtureName) },
    { label: 'Short name', value: dash(ext.shortName) },
    { label: 'Long name', value: dash(ext.longName) },
    { label: 'Revision', value: dash(ext.revision) },
    { label: 'GDTF type id', value: dash(ext.fixtureTypeId) },
    { label: 'Weight', value: ext.weightKg !== undefined && ext.weightKg > 0 ? `${fmtNum(ext.weightKg, 2)} kg` : '—' },
    { label: 'Power', value: power },
    { label: 'Overall length', value: mm(overall?.lengthM) },
    { label: 'Overall width', value: mm(overall?.widthM) },
    { label: 'Overall height', value: mm(overall?.heightM) },
    { label: 'Leg height', value: mm(ext.legHeightM) },
    { label: 'Operating temp', value: tempRange },
    { label: 'Description', value: dash(ext.description) },
  ];

  return rows.filter((r) => r.value !== '—' || [
    'Manufacturer', 'Name', 'Revision', 'GDTF type id', 'Description',
  ].includes(r.label));
}
