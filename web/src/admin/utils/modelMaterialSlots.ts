/**
 * Fetch PRISM materials for model-library slots and paint them onto a loaded GLB
 * by matching slot name to mesh object or glTF/ORBIT source material name.
 */
import * as THREE from 'three';
import { materialsApi, type ModelMaterialSlot } from '../../shared/api';
import { buildFixturePbrMaterial, type BuiltMaterial } from './fixturePbrMaterial';
import { slotKind } from './modelMaterialAssignment';

export interface SlotMaterialMaps {
  byMeshName: Map<string, THREE.Material>;
  bySourceMaterialName: Map<string, THREE.Material>;
  /** Legacy slots with no kind — match mesh.name or material.name. */
  byLegacyName: Map<string, THREE.Material>;
  built: BuiltMaterial[];
}

const EMPTY_MAPS: SlotMaterialMaps = {
  byMeshName: new Map(),
  bySourceMaterialName: new Map(),
  byLegacyName: new Map(),
  built: [],
};

/** Resolve slot materialIds into Three.js materials (deduped fetch). */
export async function fetchSlotMaterials(
  slots: ModelMaterialSlot[],
  texLoader: THREE.TextureLoader,
  maxAniso: number,
): Promise<SlotMaterialMaps> {
  const assigned = slots.filter(
    (s): s is ModelMaterialSlot & { materialId: string } => !!s.materialId,
  );
  const byId = new Map<string, THREE.Material>();
  const built: BuiltMaterial[] = [];
  if (!assigned.length) return { ...EMPTY_MAPS, built };

  await Promise.all([...new Set(assigned.map((s) => s.materialId))].map(async (id) => {
    try {
      const detail = await materialsApi.get(id);
      const bm = buildFixturePbrMaterial(detail, texLoader, maxAniso);
      built.push(bm);
      byId.set(id, bm.material);
    } catch {
      // Material may have been deleted; leave the GLB's own material in place.
    }
  }));

  const byMeshName = new Map<string, THREE.Material>();
  const bySourceMaterialName = new Map<string, THREE.Material>();
  const byLegacyName = new Map<string, THREE.Material>();

  for (const s of assigned) {
    const mat = byId.get(s.materialId);
    if (!mat) continue;
    const kind = slotKind(s);
    if (kind === 'mesh') byMeshName.set(s.name, mat);
    else if (kind === 'sourceMaterial') bySourceMaterialName.set(s.name, mat);
    else byLegacyName.set(s.name, mat);
  }

  return { byMeshName, bySourceMaterialName, byLegacyName, built };
}

function resolveMeshMaterial(
  mesh: THREE.Mesh,
  material: THREE.Material,
  maps: SlotMaterialMaps,
): THREE.Material {
  const meshOverride = maps.byMeshName.get(mesh.name);
  if (meshOverride) return meshOverride;

  let resolved = material;
  const sourceOverride = maps.bySourceMaterialName.get(material.name);
  if (sourceOverride) resolved = sourceOverride;

  const legacy = maps.byLegacyName.get(material.name) ?? maps.byLegacyName.get(mesh.name);
  if (legacy) resolved = legacy;

  return resolved;
}

/** Paint resolved slot materials onto meshes under `root`. */
export function paintModelMaterialSlots(
  root: THREE.Object3D,
  slots: ModelMaterialSlot[],
  maps: SlotMaterialMaps,
): void {
  const assignedCount = maps.byMeshName.size + maps.bySourceMaterialName.size + maps.byLegacyName.size;
  if (!assignedCount) return;

  const sole = slots.length === 1
    ? (
      maps.byMeshName.values().next().value
      ?? maps.bySourceMaterialName.values().next().value
      ?? maps.byLegacyName.values().next().value
      ?? null
    )
    : null;

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (sole) {
      mesh.material = sole;
      return;
    }
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => resolveMeshMaterial(mesh, m, maps));
    } else if (mesh.material) {
      mesh.material = resolveMeshMaterial(mesh, mesh.material, maps);
    }
  });
}
