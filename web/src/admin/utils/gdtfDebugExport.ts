import type { FixtureDefinition, FixtureDetail, FixtureWheel } from '../../shared/api';

export interface GdtfWheelSummary {
  wheelId: string;
  wheelName: string;
  wheelType: string;
  slotCount: number;
  colorSlots: number;
  goboSlots: number;
}

export function parseWheels(definition: FixtureDefinition): Array<{
  wheelId: string;
  wheelName: string;
  wheelType: string;
  slots: Array<{
    slotIndex: number;
    slotName: string;
    mediaType: string;
    imageAssetId?: string | null;
    dmxFrom?: number;
    dmxTo?: number;
    color?: string;
    mediaFileName?: string;
  }>;
}> {
  return (definition.wheels ?? []).map((w: FixtureWheel) => ({
    wheelId: w.wheelId,
    wheelName: w.wheelName,
    wheelType: w.wheelType,
    slots: (w.slots ?? []).map((s, i) => ({
      slotIndex: typeof s.slotIndex === 'number' ? s.slotIndex : i,
      slotName: s.slotName ?? `Slot ${i + 1}`,
      mediaType: s.mediaType ?? 'UNKNOWN',
      imageAssetId: s.imageAssetId ?? null,
      dmxFrom: s.dmxFrom,
      dmxTo: s.dmxTo,
      color: typeof s.metadata?.color === 'string' ? s.metadata.color : undefined,
      mediaFileName: typeof s.metadata?.mediaFileName === 'string' ? s.metadata.mediaFileName : undefined,
    })),
  }));
}

function wheelsSummary(definition: FixtureDefinition): GdtfWheelSummary[] {
  return parseWheels(definition).map((w) => ({
    wheelId: w.wheelId,
    wheelName: w.wheelName,
    wheelType: w.wheelType,
    slotCount: w.slots.length,
    colorSlots: w.slots.filter((s) => /color/i.test(s.mediaType)).length,
    goboSlots: w.slots.filter((s) => /gobo/i.test(s.mediaType)).length,
  }));
}

export function buildSummaryJson(fixture: FixtureDetail): Record<string, unknown> {
  const def = fixture.definition;
  const modes = Array.isArray(def.dmxMapping?.modes) ? def.dmxMapping.modes : [];
  return {
    exportedAt: new Date().toISOString(),
    fixtureId: fixture.id,
    fixtureInformation: def.fixtureInformation,
    partsCount: def.parts.length,
    modelsCount: def.models.length,
    beamsCount: def.beams.length,
    motionAxesCount: def.motionRig.length,
    modes: modes.map((m: Record<string, unknown>) => ({
      name: m.name,
      footprint: m.footprint,
      channelCount: Array.isArray(m.channels) ? m.channels.length : 0,
    })),
    wheels: wheelsSummary(def),
    metadata: def.metadata,
  };
}

export function buildFullMeshesJson(fixture: FixtureDetail): Record<string, unknown> {
  const def = fixture.definition;
  return {
    exportedAt: new Date().toISOString(),
    fixtureId: fixture.id,
    parts: def.parts,
    models: def.models,
    beams: def.beams,
    motionRig: def.motionRig,
  };
}

export function buildDebugBundle(fixture: FixtureDetail): Record<string, unknown> {
  return {
    exportedAt: new Date().toISOString(),
    fixture: {
      id: fixture.id,
      name: fixture.name,
      manufacturer: fixture.manufacturer,
      revision: fixture.revision,
      sourceGdtfHash: fixture.sourceGdtfHash,
      hasPreview: fixture.hasPreview,
    },
    summary: buildSummaryJson(fixture),
    meshes: buildFullMeshesJson(fixture),
    definition: fixture.definition,
  };
}

export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function meshVertexCount(metadata: Record<string, unknown>): number | null {
  for (const key of ['vertices', 'vertexCount', 'vtx', 'vertex_count']) {
    const v = metadata[key];
    if (typeof v === 'number' && v > 0) return v;
  }
  return null;
}
