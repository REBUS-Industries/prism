/**
 * Unit coverage for the per-material PBR parameter contract: the canonical
 * defaults, the partial-validation Zod schema, and the read-time merge that
 * fills a stored partial back out to a complete object. Pure functions — no
 * DB / Fastify.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATERIAL_PARAMETERS,
  materialParametersSchema,
  mergeParameters,
} from '../src/materials/parameters.js';

describe('DEFAULT_MATERIAL_PARAMETERS', () => {
  it('carries the documented keys with their default values', () => {
    // Core PBR (unchanged)
    expect(DEFAULT_MATERIAL_PARAMETERS.baseColor).toBe('#ffffff');
    expect(DEFAULT_MATERIAL_PARAMETERS.roughness).toBe(1.0);
    expect(DEFAULT_MATERIAL_PARAMETERS.metallic).toBe(0.0);
    expect(DEFAULT_MATERIAL_PARAMETERS.doubleSided).toBe(false);
    expect(DEFAULT_MATERIAL_PARAMETERS.flipNormalY).toBe(false);
    // New base params
    expect(DEFAULT_MATERIAL_PARAMETERS.alphaMode).toBe('opaque');
    expect(DEFAULT_MATERIAL_PARAMETERS.clearCoatFactor).toBe(0);
    expect(DEFAULT_MATERIAL_PARAMETERS.transmissionFactor).toBe(0);
    expect(DEFAULT_MATERIAL_PARAMETERS.ior).toBe(1.5);
    expect(DEFAULT_MATERIAL_PARAMETERS.specularFactor).toBe(1.0);
    expect(DEFAULT_MATERIAL_PARAMETERS.specularColor).toBe('#ffffff');
    // Extensions
    expect(DEFAULT_MATERIAL_PARAMETERS.activeExtensions).toEqual(['clearCoat', 'transmission', 'ior', 'specular']);
    expect(DEFAULT_MATERIAL_PARAMETERS.unlit).toBe(false);
  });
});

describe('mergeParameters', () => {
  it('returns a fresh copy of the defaults for empty / non-object input', () => {
    expect(mergeParameters({})).toEqual(DEFAULT_MATERIAL_PARAMETERS);
    expect(mergeParameters(null)).toEqual(DEFAULT_MATERIAL_PARAMETERS);
    expect(mergeParameters(undefined)).toEqual(DEFAULT_MATERIAL_PARAMETERS);
    expect(mergeParameters('garbage')).toEqual(DEFAULT_MATERIAL_PARAMETERS);
    // A fresh object each call — never the shared default reference.
    expect(mergeParameters({})).not.toBe(DEFAULT_MATERIAL_PARAMETERS);
  });

  it('overlays only the stored keys on top of the defaults', () => {
    const merged = mergeParameters({ roughness: 0.3, baseColor: '#ff0000', doubleSided: true });
    expect(merged.roughness).toBe(0.3);
    expect(merged.baseColor).toBe('#ff0000');
    expect(merged.doubleSided).toBe(true);
    // Untouched keys still come from the defaults.
    expect(merged.metallic).toBe(0.0);
    expect(merged.opacity).toBe(1.0);
    expect(merged.emissiveColor).toBe('#000000');
  });

  it('ignores unknown / null keys in the stored partial', () => {
    const merged = mergeParameters({ roughness: 0.5, bogus: 'x', metallic: null });
    expect(merged.roughness).toBe(0.5);
    expect(merged.metallic).toBe(0.0); // null stored value falls back to default
    expect(merged).not.toHaveProperty('bogus');
    // Key count matches the full DEFAULT_MATERIAL_PARAMETERS
    expect(Object.keys(merged)).toHaveLength(Object.keys(DEFAULT_MATERIAL_PARAMETERS).length);
  });
});

describe('materialParametersSchema', () => {
  it('accepts a valid partial and strips unknown keys', () => {
    const parsed = materialParametersSchema.parse({
      roughness: 0.5,
      metallic: 1,
      baseColor: '#AABBCC',
      tilingX: 2,
      extra: 'nope',
    });
    expect(parsed).toEqual({ roughness: 0.5, metallic: 1, baseColor: '#AABBCC', tilingX: 2 });
    expect(parsed).not.toHaveProperty('extra');
  });

  it('accepts an empty object (all keys optional)', () => {
    expect(materialParametersSchema.parse({})).toEqual({});
  });

  it('rejects out-of-range numbers', () => {
    expect(materialParametersSchema.safeParse({ roughness: 1.5 }).success).toBe(false);
    expect(materialParametersSchema.safeParse({ metallic: -0.1 }).success).toBe(false);
    expect(materialParametersSchema.safeParse({ opacity: 2 }).success).toBe(false);
    expect(materialParametersSchema.safeParse({ normalScale: 3 }).success).toBe(false);
    expect(materialParametersSchema.safeParse({ aoIntensity: 1.1 }).success).toBe(false);
    expect(materialParametersSchema.safeParse({ emissiveIntensity: -1 }).success).toBe(false);
    // tiling must be strictly positive.
    expect(materialParametersSchema.safeParse({ tilingX: 0 }).success).toBe(false);
    expect(materialParametersSchema.safeParse({ tilingY: -1 }).success).toBe(false);
  });

  it('allows unbounded scalars and signed offsets/displacement', () => {
    expect(materialParametersSchema.safeParse({ displacementScale: -5, displacementBias: 2 }).success).toBe(true);
    expect(materialParametersSchema.safeParse({ offsetX: -3.5, offsetY: 10 }).success).toBe(true);
    expect(materialParametersSchema.safeParse({ emissiveIntensity: 25 }).success).toBe(true);
  });

  it('rejects malformed hex colours', () => {
    expect(materialParametersSchema.safeParse({ baseColor: 'red' }).success).toBe(false);
    expect(materialParametersSchema.safeParse({ baseColor: '#fff' }).success).toBe(false);
    expect(materialParametersSchema.safeParse({ baseColor: '#1234567' }).success).toBe(false);
    expect(materialParametersSchema.safeParse({ emissiveColor: '#00ff00' }).success).toBe(true);
  });

  it('rejects wrong types for booleans / numbers', () => {
    expect(materialParametersSchema.safeParse({ doubleSided: 'true' }).success).toBe(false);
    expect(materialParametersSchema.safeParse({ roughness: '0.5' }).success).toBe(false);
  });
});
