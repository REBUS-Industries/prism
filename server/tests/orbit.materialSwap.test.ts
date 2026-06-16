/**
 * Unit tests for ORBIT material swap helpers (hashing, mapping, re-hash).
 */
import { describe, expect, it } from 'vitest';
import { computeObjectId, hexColorToArgbLong } from '../src/orbit/objectHash.js';
import { rehashGraphAfterMutation, isMeshObject } from '../src/orbit/graphWalker.js';
import { buildOrbitRenderMaterial } from '../src/orbit/prismToRenderMaterial.js';
import { DEFAULT_MATERIAL_PARAMETERS, mergeParameters } from '../src/materials/parameters.js';
import type { MaterialDetail } from '../src/materials/loadDetail.js';

describe('hexColorToArgbLong', () => {
  it('packs opaque white', () => {
    expect(hexColorToArgbLong('#ffffff')).toBe(4294967295);
  });

  it('packs opaque red', () => {
    expect(hexColorToArgbLong('#ff0000')).toBe(4294901760);
  });
});

describe('computeObjectId', () => {
  it('is stable for the same payload', () => {
    const obj = { speckle_type: 'Objects.Other.RenderMaterial', name: 'test', opacity: 1 };
    expect(computeObjectId(obj)).toBe(computeObjectId(obj));
  });

  it('changes when content changes', () => {
    const a = { speckle_type: 'Objects.Other.RenderMaterial', name: 'a', opacity: 1 };
    const b = { speckle_type: 'Objects.Other.RenderMaterial', name: 'b', opacity: 1 };
    expect(computeObjectId(a)).not.toBe(computeObjectId(b));
  });
});

describe('buildOrbitRenderMaterial', () => {
  const material: MaterialDetail = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Concrete',
    description: null,
    tags: [],
    thumbnailTextureId: null,
    branchedFromId: null,
    groupId: null,
    createdByAdminId: null,
    createdByApiKeyId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parameters: mergeParameters({ baseColor: '#808080', roughness: 0.6, metallic: 0.1 }),
    slotsTotal: 8,
    slotsFilled: 1,
    slots: [],
  };

  it('maps scalar PBR parameters', () => {
    const rm = buildOrbitRenderMaterial(material, {});
    expect(rm.speckle_type).toBe('Objects.Other.RenderMaterial');
    expect(rm.name).toBe('Concrete');
    expect(rm.roughness).toBe(0.6);
    expect(rm.metalness).toBe(0.1);
    expect(rm.diffuse).toBe(hexColorToArgbLong('#808080'));
  });

  it('maps uploaded blob ids to texture fields', () => {
    const rm = buildOrbitRenderMaterial(material, {
      baseColor: 'abc1234567',
      normal: 'norm123456',
    });
    expect(rm.baseColorTexture).toBe('abc1234567');
    expect(rm.diffuseTexture).toBe('abc1234567');
    expect(rm.normalTexture).toBe('norm123456');
    expect(rm.diffuse).toBe(4278190080);
  });
});

describe('rehashGraphAfterMutation', () => {
  it('re-hashes mesh and parent when renderMaterial changes', () => {
    const meshId = computeObjectId({
      speckle_type: 'Objects.Geometry.Mesh',
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      faces: [3, 0, 1, 2],
      renderMaterial: { speckle_type: 'Objects.Other.RenderMaterial', name: 'old', opacity: 1, roughness: 0.5, metalness: 0, diffuse: 4294967295, emissive: 4278190080 },
    });

    const layerId = computeObjectId({
      speckle_type: 'Speckle.Core.Models.Collections.Collection',
      name: 'Default',
      elements: [{ referencedId: meshId, speckle_type: 'reference' }],
    });

    const rootId = computeObjectId({
      speckle_type: 'Speckle.Core.Models.Collections.Collection',
      name: 'root',
      elements: [{ referencedId: layerId, speckle_type: 'reference' }],
    });

    const mesh = {
      id: meshId,
      speckle_type: 'Objects.Geometry.Mesh',
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      faces: [3, 0, 1, 2],
      renderMaterial: { speckle_type: 'Objects.Other.RenderMaterial', name: 'old', opacity: 1, roughness: 0.5, metalness: 0, diffuse: 4294967295, emissive: 4278190080 },
    };
    const layer = {
      id: layerId,
      speckle_type: 'Speckle.Core.Models.Collections.Collection',
      name: 'Default',
      elements: [{ referencedId: meshId, speckle_type: 'reference' }],
    };
    const root = {
      id: rootId,
      speckle_type: 'Speckle.Core.Models.Collections.Collection',
      name: 'root',
      elements: [{ referencedId: layerId, speckle_type: 'reference' }],
      __closure: { [layerId]: 1, [meshId]: 2 },
    };

    const objects = new Map([
      [meshId, mesh],
      [layerId, layer],
      [rootId, root],
    ]);
    const originalIds = new Set(objects.keys());

    mesh.renderMaterial = {
      speckle_type: 'Objects.Other.RenderMaterial',
      name: 'new',
      opacity: 1,
      roughness: 0.2,
      metalness: 0.8,
      diffuse: 4294901760,
      emissive: 4278190080,
    };

    const { rootObjectId, toUpload, idMap } = rehashGraphAfterMutation(objects, originalIds);

    expect(rootObjectId).not.toBe(rootId);
    expect(idMap.has(meshId)).toBe(true);
    expect(toUpload.length).toBeGreaterThan(0);
    expect(isMeshObject(objects.get(idMap.get(meshId) ?? meshId)!)).toBe(true);
  });
});
