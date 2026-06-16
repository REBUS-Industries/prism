/**
 * ORBIT object id computation — MD5 of JSON body excluding `id` and `__closure`.
 * Matches `Orbit.Sdk.Serialisation.OrbitSerializer.ComputeHash`.
 */
import { createHash } from 'node:crypto';

export function computeObjectId(obj: Record<string, unknown>): string {
  const clone = structuredClone(obj);
  delete clone.id;
  delete clone.__closure;
  return createHash('md5').update(JSON.stringify(clone), 'utf8').digest('hex');
}

/** Lowercase hex SHA-256 of binary blob bytes (texture content hash). */
export function computeBlobContentHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Pack #rrggbb into unsigned ARGB long (Speckle / ORBIT convention). */
export function hexColorToArgbLong(hex: string): number {
  const h = hex.replace(/^#/, '');
  if (h.length !== 6) return 4294967295;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return ((255 << 24) | (r << 16) | (g << 8) | b) >>> 0;
}
