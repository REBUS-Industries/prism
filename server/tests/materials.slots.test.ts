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
  megascansImportParameters,
  textureMatchesSlot,
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
      ['rock_Bump.jpg', 'displacement'],
      ['fabric_Cavity.jpg', 'ao'],
      ['metal_Gloss.jpg', 'roughness'],
      ['metal_Glossiness.jpg', 'roughness'],
      ['Uncut_Grass_oilpt20_8K_Bump.jpg', 'displacement'],
      ['Uncut_Grass_oilpt20_8K_Cavity.jpg', 'ao'],
      ['Uncut_Grass_oilpt20_8K_Gloss.jpg', 'roughness'],
      ['Uncut_Grass_oilpt20_8K_Specular.jpg', 'metallic'],
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

describe('textureMatchesSlot', () => {
  it('matches any suffix token for the requested slot', () => {
    expect(textureMatchesSlot('surface_Normal.png', 'normal')).toBe(true);
    expect(textureMatchesSlot('terrain_height.png', 'displacement')).toBe(true);
    expect(textureMatchesSlot('rockface_2k_Albedo.jpg', 'albedo')).toBe(true);
    expect(textureMatchesSlot('surface_Normal.png', 'roughness')).toBe(false);
    expect(textureMatchesSlot('random.png', 'normal')).toBe(false);
  });

  it('can match a slot token even when detectSlot would pick another slot', () => {
    expect(textureMatchesSlot('foo_color_normal.png', 'normal')).toBe(true);
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

describe('megascansImportParameters', () => {
  it('flags gloss maps for roughness inversion and specular maps for metallic routing', () => {
    expect(megascansImportParameters({
      roughness: 'Uncut_Grass_oilpt20_8K_Gloss.jpg',
    })).toEqual({ roughnessInvertFromGloss: true });

    expect(megascansImportParameters({
      metallic: 'Uncut_Grass_oilpt20_8K_Specular.jpg',
    })).toEqual({ specularMapInMetallicSlot: true, metallic: 0 });

    expect(megascansImportParameters({
      roughness: 'ground_Roughness.jpg',
      metallic: 'metal_Metallic.jpg',
    })).toEqual({});
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
