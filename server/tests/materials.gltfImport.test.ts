/**
 * Unit coverage for glTF / GLB packaged material import slot extraction.
 */
import { describe, expect, it } from 'vitest';
import { isGltfPackage, parseGltfMaterialZip, type ZipFileEntry } from '../src/materials/gltfImport.js';

function makeEntry(name: string, data: Buffer): ZipFileEntry {
  return {
    entryName: name,
    isDirectory: false,
    getData: () => data,
  };
}

/** Minimal 1×1 PNG (valid image bytes for content-type checks downstream). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function buildGltfZip(): ZipFileEntry[] {
  const gltf = JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ uri: 'material.bin', byteLength: 8 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }],
    images: [
      { uri: 'textures/albedo.png', mimeType: 'image/png' },
      { uri: 'textures/normal.png', mimeType: 'image/png' },
      { uri: 'textures/orm.png', mimeType: 'image/png' },
      { uri: 'textures/ao.png', mimeType: 'image/png' },
    ],
    textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }],
    materials: [{
      name: 'BrickWall',
      pbrMetallicRoughness: {
        baseColorFactor: [0.8, 0.2, 0.1, 1],
        metallicFactor: 0.1,
        roughnessFactor: 0.6,
        baseColorTexture: { index: 0 },
        metallicRoughnessTexture: { index: 2 },
      },
      normalTexture: { index: 1, scale: 1.2 },
      occlusionTexture: { index: 3, strength: 0.9 },
      emissiveFactor: [0, 0, 0],
      alphaMode: 'OPAQUE',
    }],
  });

  return [
    makeEntry('pack/scene.gltf', Buffer.from(gltf, 'utf8')),
    makeEntry('pack/material.bin', Buffer.alloc(8)),
    makeEntry('pack/textures/albedo.png', PNG_1X1),
    makeEntry('pack/textures/normal.png', PNG_1X1),
    makeEntry('pack/textures/orm.png', PNG_1X1),
    makeEntry('pack/textures/ao.png', PNG_1X1),
    makeEntry('pack/oilpt20.json', Buffer.from('{"vendor":"megascans"}')),
  ];
}

function buildGlbZip(): ZipFileEntry[] {
  const json = JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: PNG_1X1.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: PNG_1X1.length }],
    images: [{ bufferView: 0, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [{
      name: 'Embedded',
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        baseColorFactor: [1, 1, 1, 0.5],
      },
      alphaMode: 'BLEND',
    }],
  });

  const jsonBuf = Buffer.from(json, 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (PNG_1X1.length % 4)) % 4;
  const binChunk = Buffer.concat([PNG_1X1, Buffer.alloc(binPad, 0x00)]);

  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const glb = Buffer.alloc(totalLength);
  let o = 0;
  glb.writeUInt32LE(0x46546c67, o); o += 4;
  glb.writeUInt32LE(2, o); o += 4;
  glb.writeUInt32LE(totalLength, o); o += 4;
  glb.writeUInt32LE(jsonChunk.length, o); o += 4;
  glb.writeUInt32LE(0x4e4f534a, o); o += 4;
  jsonChunk.copy(glb, o); o += jsonChunk.length;
  glb.writeUInt32LE(binChunk.length, o); o += 4;
  glb.writeUInt32LE(0x004e4942, o); o += 4;
  binChunk.copy(glb, o);

  return [makeEntry('model.glb', glb)];
}

describe('isGltfPackage', () => {
  it('detects gltf/glb entries', () => {
    expect(isGltfPackage([makeEntry('a.gltf', Buffer.from('{}'))])).toBe(true);
    expect(isGltfPackage([makeEntry('a.glb', Buffer.alloc(12))])).toBe(true);
    expect(isGltfPackage([makeEntry('rock_Albedo.jpg', PNG_1X1)])).toBe(false);
  });
});

describe('parseGltfMaterialZip', () => {
  it('returns null for image-only Megascans zips', () => {
    expect(parseGltfMaterialZip([
      makeEntry('rock_Albedo.jpg', PNG_1X1),
      makeEntry('rock_Normal.jpg', PNG_1X1),
    ])).toBeNull();
  });

  it('maps glTF material texture indices to PRISM slots', () => {
    const result = parseGltfMaterialZip(buildGltfZip());
    expect(result).not.toBeNull();
    expect(result!.materialName).toBe('BrickWall');
    expect(result!.slots.albedo?.filename).toBe('albedo.png');
    expect(result!.slots.normal?.filename).toBe('normal.png');
    expect(result!.slots.roughness?.filename).toBe('orm.png');
    expect(result!.slots.metallic?.filename).toBe('orm.png');
    expect(result!.slots.ao?.filename).toBe('ao.png');
    expect(result!.parameters.baseColor).toBe('#cc331a');
    expect(result!.parameters.roughness).toBe(0.6);
    expect(result!.parameters.metallic).toBe(0.1);
    expect(result!.parameters.normalScale).toBe(1.2);
    expect(result!.parameters.aoIntensity).toBe(0.9);
    expect(result!.skipped).toContain('oilpt20.json');
    expect(result!.skipped).not.toContain('albedo.png');
  });

  it('parses embedded GLB textures', () => {
    const result = parseGltfMaterialZip(buildGlbZip());
    expect(result).not.toBeNull();
    expect(result!.materialName).toBe('Embedded');
    expect(result!.slots.albedo?.data.length).toBeGreaterThan(0);
    expect(result!.parameters.alphaMode).toBe('blend');
    expect(result!.parameters.opacity).toBe(0.5);
  });
});
