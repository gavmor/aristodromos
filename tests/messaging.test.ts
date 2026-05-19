import { describe, it, expect } from 'vitest';
import { isAbortError } from '../utils/messaging';

describe('isAbortError', () => {
  it('returns true for DOMException AbortError', () => {
    const err = new DOMException('Aborted', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });

  it('returns false for generic Error', () => {
    expect(isAbortError(new Error('fail'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isAbortError('string')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError({})).toBe(false);
  });

  it('returns false for DOMException with different name', () => {
    const err = new DOMException('Not found', 'NotFoundError');
    expect(isAbortError(err)).toBe(false);
  });
});
