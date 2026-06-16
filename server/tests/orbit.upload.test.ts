/**
 * ORBIT REST upload helpers — multipart object batch format.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadObjects } from '../src/orbit/upload.js';

describe('uploadObjects', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs multipart/form-data with object-batch JSON array', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer test-token');
      expect(headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);

      expect(init?.body).toBeInstanceOf(Buffer);
      const body = (init!.body as Buffer).toString('latin1');
      expect(body).toContain('object-batch');
      expect(body).toContain('"Objects.Other.RenderMaterial"');

      return new Response(null, { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await uploadObjects(
      { url: 'https://orbit.example', token: 'test-token' },
      'proj123',
      [{ id: 'abc', speckle_type: 'Objects.Other.RenderMaterial', name: 'test' }],
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://orbit.example/objects/proj123');
  });
});
