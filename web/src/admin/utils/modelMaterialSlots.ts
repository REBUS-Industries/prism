/**
 * Fetch PRISM materials for model-library slots and paint them onto a loaded GLB
 * by matching slot name to mesh/material name (same rules as ModelViewer).
 */
import * as THREE from 'three';
import { materialsApi, type ModelMaterialSlot } from '../../shared/api';
import { buildFixturePbrMaterial, type BuiltMaterial } from './fixturePbrMaterial';

export interface SlotMaterialMaps {
  bySlotName: Map<string, THREE.Material>;
  built: BuiltMaterial[];
}

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
  if (!assigned.length) return { bySlotName: new Map(), built };

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

  const bySlotName = new Map<string, THREE.Material>();
  for (const s of assigned) {
    const mat = byId.get(s.materialId);
    if (mat) bySlotName.set(s.name, mat);
  }
  return { bySlotName, built };
}

/** Paint resolved slot materials onto meshes under `root`. */
export function paintModelMaterialSlots(
  root: THREE.Object3D,
  slots: ModelMaterialSlot[],
  bySlotName: Map<string, THREE.Material>,
): void {
  if (!bySlotName.size) return;
  const sole = slots.length === 1 ? bySlotName.values().next().value ?? null : null;

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (sole) {
      mesh.material = sole;
      return;
    }
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => bySlotName.get(m.name) ?? m);
    } else if (mesh.material) {
      mesh.material = bySlotName.get(mesh.material.name) ?? bySlotName.get(mesh.name) ?? mesh.material;
    }
  });
}
