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
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-token' });
      expect(init?.body).toBeInstanceOf(FormData);

      const form = init!.body as FormData;
      const part = form.get('object-batch');
      expect(part).toBeInstanceOf(Blob);
      const text = await (part as Blob).text();
      expect(JSON.parse(text)).toEqual([
        { id: 'abc', speckle_type: 'Objects.Other.RenderMaterial', name: 'test' },
      ]);

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
