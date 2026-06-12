/**
 * Fab URL normalization and validation helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  InvalidHttpUrlError,
  isInvalidUrlError,
  isUnreachableNetworkError,
  normalizeHttpUrl,
  normalizeOptionalHttpUrl,
} from '../src/fab/urlValidation.js';

describe('fab urlValidation', () => {
  it('treats empty values as unset', () => {
    expect(normalizeOptionalHttpUrl('')).toBeNull();
    expect(normalizeOptionalHttpUrl('   ')).toBeNull();
    expect(normalizeOptionalHttpUrl(undefined)).toBeNull();
  });

  it('auto-prefixes http:// for host:port URLs', () => {
    expect(normalizeHttpUrl('127.0.0.1:8191')).toBe('http://127.0.0.1:8191');
    expect(normalizeHttpUrl('proxy.local:8080')).toBe('http://proxy.local:8080');
  });

  it('accepts explicit http(s) URLs', () => {
    expect(normalizeHttpUrl('http://127.0.0.1:8191/v1')).toBe('http://127.0.0.1:8191/v1');
    expect(normalizeHttpUrl('https://proxy.example:8443/')).toBe('https://proxy.example:8443/');
  });

  it('rejects malformed URLs', () => {
    expect(() => normalizeHttpUrl('not a url')).toThrow(InvalidHttpUrlError);
    expect(() => normalizeHttpUrl('ftp://files.example/')).toThrow(InvalidHttpUrlError);
  });

  it('detects invalid URL fetch errors', () => {
    expect(isInvalidUrlError(new TypeError('Failed to parse URL from 127.0.0.1:8191/v1'))).toBe(true);
    expect(isInvalidUrlError(new Error('Invalid URL protocol'))).toBe(true);
  });

  it('detects unreachable network errors', () => {
    expect(isUnreachableNetworkError({ cause: { code: 'ECONNREFUSED' } })).toBe(true);
    expect(isUnreachableNetworkError(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))).toBe(true);
  });
});
