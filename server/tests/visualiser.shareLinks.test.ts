/**
 * Share-token mint/hash invariants (the DB-free half of the share-link
 * feature). The full mint→exchange→expiry HTTP path is exercised against a
 * live run row and is covered by the integration layer; here we lock down
 * the crypto contract: URL-safe opaque plaintext, deterministic SHA-256
 * hash, and that only the hash is ever persistable.
 */
import { describe, expect, it } from 'vitest';
import { mintShareToken, hashShareToken } from '../src/visualiser/shareLinks.js';

describe('shareLinks', () => {
  it('mints a URL-safe opaque token and its sha-256 hash', () => {
    const { plaintext, hash } = mintShareToken();
    expect(plaintext).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(plaintext.length).toBeGreaterThanOrEqual(40);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShareToken(plaintext)).toBe(hash); // hash is deterministic
  });

  it('produces unguessable, unique tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(mintShareToken().plaintext);
    expect(seen.size).toBe(100);
  });

  it('hashes differ for different plaintext (no collisions on a flipped char)', () => {
    const a = hashShareToken('share-token-aaaa');
    const b = hashShareToken('share-token-aaab');
    expect(a).not.toBe(b);
  });
});
