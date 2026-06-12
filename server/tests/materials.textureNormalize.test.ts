import { describe, expect, it } from 'vitest';
import { textureNeedsWebNormalize, WEB_NATIVE_TEXTURE_TYPES } from '../src/materials/textureNormalize.js';

describe('textureNeedsWebNormalize', () => {
  it('passes through PNG/JPEG', () => {
    expect(textureNeedsWebNormalize('image/png', 'rock_basecolor.png')).toBe(false);
    expect(textureNeedsWebNormalize('image/jpeg', 'rock_roughness.jpg')).toBe(false);
  });

  it('converts TIFF from content-type or extension', () => {
    expect(textureNeedsWebNormalize('image/tiff', 'T_Lava_01_basecolor.tif')).toBe(true);
    expect(textureNeedsWebNormalize('application/octet-stream', 'T_Lava_01_normal.tiff')).toBe(true);
  });

  it('converts TGA/EXR/HDR extensions', () => {
    expect(textureNeedsWebNormalize('application/octet-stream', 'rock_nrm.tga')).toBe(true);
    expect(textureNeedsWebNormalize('image/x-exr', 'rock_disp.exr')).toBe(true);
    expect(textureNeedsWebNormalize('image/vnd.radiance', 'studio.hdr')).toBe(true);
  });

  it('web-native set is stable', () => {
    expect(WEB_NATIVE_TEXTURE_TYPES.has('image/png')).toBe(true);
    expect(WEB_NATIVE_TEXTURE_TYPES.has('image/tiff')).toBe(false);
  });
});
