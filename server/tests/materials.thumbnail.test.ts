/**
 * Unit coverage for material preview thumbnail helpers.
 */
import { describe, expect, it } from 'vitest';
import { isMaterialPreviewTag, MAX_MATERIAL_THUMBNAIL_BYTES } from '../src/materials/saveThumbnail.js';

describe('saveMaterialThumbnail helpers', () => {
  it('recognises the material-preview tag', () => {
    expect(isMaterialPreviewTag(['material-preview'])).toBe(true);
    expect(isMaterialPreviewTag(['pbr', 'material-preview'])).toBe(true);
    expect(isMaterialPreviewTag(['pbr'])).toBe(false);
    expect(isMaterialPreviewTag(null)).toBe(false);
  });

  it('caps thumbnail uploads at 2 MB', () => {
    expect(MAX_MATERIAL_THUMBNAIL_BYTES).toBe(2 * 1024 * 1024);
  });
});
