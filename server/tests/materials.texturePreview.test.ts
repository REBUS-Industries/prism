import { describe, expect, it } from 'vitest';
import { texturePreviewUrl } from '../src/materials/texturePreview.js';

describe('texturePreviewUrl', () => {
  it('builds the preview route for a texture id', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(texturePreviewUrl(id)).toBe(`/api/textures/${id}/preview`);
  });
});
