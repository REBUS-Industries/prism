/**
 * Unit coverage for the Megascans-style slot detection + image helpers used
 * by the `/api/materials` import endpoint. Pure functions — no DB / Fastify.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_SLOTS,
  detectSlot,
  imageContentType,
  isImageFilename,
  isMaterialSlot,
} from '../src/materials/slots.js';

describe('detectSlot', () => {
  it('maps Megascans-style suffixes to the right slot (case-insensitive)', () => {
    const cases: Array<[string, string]> = [
      ['rockface_2k_Albedo.jpg', 'albedo'],
      ['T_Brick_BaseColor.png', 'albedo'],
      ['wood_diffuse.png', 'albedo'],
      ['plate_COL.png', 'albedo'],
      ['surface_Normal.png', 'normal'],
      ['surface_nrm.png', 'normal'],
      ['ground_Roughness.jpg', 'roughness'],
      ['ground_rgh.jpg', 'roughness'],
      ['metal_Metallic.jpg', 'metallic'],
      ['metal_metalness.jpg', 'metallic'],
      ['cliff_AO.jpg', 'ao'],
      ['cliff_ambientocclusion.jpg', 'ao'],
      ['lava_Emissive.png', 'emissive'],
      ['leaf_opacity.png', 'opacity'],
      ['leaf_alpha.png', 'opacity'],
      ['terrain_Displacement.exr', 'displacement'],
      ['terrain_height.png', 'displacement'],
      ['ROCK_NORMAL.PNG', 'normal'],
    ];
    for (const [filename, slot] of cases) {
      expect(detectSlot(filename), filename).toBe(slot);
    }
  });

  it('returns null when no token matches', () => {
    expect(detectSlot('random.png')).toBeNull();
    expect(detectSlot('readme.txt')).toBeNull();
    expect(detectSlot('preview.jpg')).toBeNull();
  });

  it('honours slot priority order when a name matches multiple tokens', () => {
    // albedo precedes normal in ALLOWED_SLOTS, so albedo wins.
    expect(detectSlot('foo_color_normal.png')).toBe('albedo');
  });
});

describe('image helpers', () => {
  it('recognises common image extensions and maps content types', () => {
    expect(isImageFilename('foo.png')).toBe(true);
    expect(isImageFilename('foo.exr')).toBe(true);
    expect(isImageFilename('foo.JPG')).toBe(true);
    expect(isImageFilename('manifest.json')).toBe(false);
    expect(isImageFilename('noext')).toBe(false);
    expect(imageContentType('a.jpg')).toBe('image/jpeg');
    expect(imageContentType('a.JPEG')).toBe('image/jpeg');
    expect(imageContentType('a.exr')).toBe('image/x-exr');
    expect(imageContentType('a.txt')).toBeNull();
  });
});

describe('isMaterialSlot', () => {
  it('accepts exactly the eight known slots', () => {
    expect(ALLOWED_SLOTS).toHaveLength(8);
    for (const slot of ALLOWED_SLOTS) expect(isMaterialSlot(slot)).toBe(true);
    expect(isMaterialSlot('specular')).toBe(false);
    expect(isMaterialSlot('')).toBe(false);
  });
});
