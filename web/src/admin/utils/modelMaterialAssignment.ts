/**
 * Split/merge model material slots by assignment mode and discover slot names
 * from GLB previews or definition metadata.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type * as THREE from 'three';
import type { ModelDefinition, ModelMaterialSlot, ModelMaterialSlotKind } from '../../shared/api';

export type { ModelMaterialSlotKind };

export function slotKind(slot: ModelMaterialSlot): ModelMaterialSlotKind | 'legacy' {
  return slot.kind ?? 'legacy';
}

/** Split persisted slots into mesh-object vs source-material lists. */
export function splitPersistedMaterialSlots(slots: ModelMaterialSlot[]): {
  mesh: ModelMaterialSlot[];
  sourceMaterial: ModelMaterialSlot[];
} {
  const mesh: ModelMaterialSlot[] = [];
  const sourceMaterial: ModelMaterialSlot[] = [];
  for (const s of slots) {
    const entry = { name: s.name, materialId: s.materialId ?? null, kind: s.kind };
    if (s.kind === 'sourceMaterial') {
      sourceMaterial.push({ ...entry, kind: 'sourceMaterial' });
    } else if (s.kind === 'mesh') {
      mesh.push({ ...entry, kind: 'mesh' });
    } else {
      // Legacy rows without kind — keep kind unset for dual-match painting.
      mesh.push({ name: s.name, materialId: s.materialId ?? null });
    }
  }
  return { mesh, sourceMaterial };
}

/** Combine editor lists for persistence and GLB preview painting. */
export function mergePersistedMaterialSlots(
  mesh: ModelMaterialSlot[],
  sourceMaterial: ModelMaterialSlot[],
): ModelMaterialSlot[] {
  return [
    ...mesh.map((s) => {
      const row: ModelMaterialSlot = { name: s.name, materialId: s.materialId ?? null };
      if (s.kind) row.kind = s.kind;
      return row;
    }),
    ...sourceMaterial.map((s) => ({
      name: s.name,
      materialId: s.materialId ?? null,
      kind: 'sourceMaterial' as const,
    })),
  ];
}

export function namesToMaterialSlots(
  names: string[],
  kind: ModelMaterialSlotKind,
): ModelMaterialSlot[] {
  return names.map((name) => ({ name, materialId: null, kind }));
}

/** Preserve saved materialId assignments when refreshing discovered slot names. */
export function mergeMaterialSlotsWithKind(
  persisted: ModelMaterialSlot[],
  discovered: ModelMaterialSlot[],
  kind: ModelMaterialSlotKind,
): ModelMaterialSlot[] {
  const byName = new Map(
    persisted
      .filter((s) => (s.kind ?? 'mesh') === kind)
      .map((s) => [s.name, s.materialId ?? null]),
  );
  return discovered.map((slot) => ({
    name: slot.name,
    materialId: byName.get(slot.name) ?? null,
    kind,
  }));
}

/** Mesh part names from definition.meshes (import metadata). */
export function meshNamesFromDefinition(definition: ModelDefinition | null | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const mesh of definition?.meshes ?? []) {
    const name = mesh.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Scan a preview GLB for mesh object names and glTF material names. */
export async function discoverGlbSlotNames(url: string): Promise<{
  meshNames: string[];
  sourceMaterialNames: string[];
}> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const meshNames: string[] = [];
  const sourceMaterialNames: string[] = [];
  const seenMesh = new Set<string>();
  const seenMat = new Set<string>();

  gltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    const meshName = mesh.name?.trim();
    if (meshName && !seenMesh.has(meshName)) {
      seenMesh.add(meshName);
      meshNames.push(meshName);
    }

    const mats = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const m of mats) {
      const matName = m.name?.trim();
      if (matName && !seenMat.has(matName)) {
        seenMat.add(matName);
        sourceMaterialNames.push(matName);
      }
    }
  });

  return { meshNames, sourceMaterialNames };
}
