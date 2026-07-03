import { describe, expect, it } from 'vitest';
import { selectVersionIdsDeletableBefore, type OrbitVersionSummary } from '../src/orbit/client.js';

function version(id: string, createdAt: string): OrbitVersionSummary {
  return { id, createdAt, message: null, sourceApplication: null, referencedObject: null, authorName: null };
}

describe('selectVersionIdsDeletableBefore', () => {
  it('returns empty when the model has only one version', () => {
    const items = [version('a', '2026-01-01T00:00:00.000Z')];
    expect(selectVersionIdsDeletableBefore(items, new Date('2026-06-01T00:00:00.000Z'))).toEqual([]);
  });

  it('deletes versions strictly older than the cutoff', () => {
    const items = [
      version('new', '2026-06-02T00:00:00.000Z'),
      version('old', '2026-05-01T00:00:00.000Z'),
      version('older', '2026-04-01T00:00:00.000Z'),
    ];
    expect(selectVersionIdsDeletableBefore(items, new Date('2026-06-01T00:00:00.000Z'))).toEqual(['old', 'older']);
  });

  it('keeps at least one version even when all are older than the cutoff', () => {
    const items = [
      version('newest', '2026-03-02T00:00:00.000Z'),
      version('old', '2026-03-01T00:00:00.000Z'),
    ];
    expect(selectVersionIdsDeletableBefore(items, new Date('2026-06-01T00:00:00.000Z'))).toEqual(['old']);
  });
});
