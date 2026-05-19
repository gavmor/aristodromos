import { describe, it, expect } from 'vitest';
import { buildOtResponse, executeOT } from '../utils/content-handler';
import type { Operation } from 'fast-json-patch';

describe('buildOtResponse', () => {
  it('returns success when no error', () => {
    expect(buildOtResponse()).toEqual({ status: 'success' });
  });

  it('returns canceled for AbortError', () => {
    const err = new DOMException('Aborted', 'AbortError');
    expect(buildOtResponse(err)).toEqual({ status: 'canceled' });
  });

  it('returns error with message for generic Error', () => {
    const err = new Error('Something broke');
    expect(buildOtResponse(err)).toEqual({ status: 'error', error: 'Something broke' });
  });

  it('returns error with stringified value for non-Error throws', () => {
    expect(buildOtResponse('string error')).toEqual({ status: 'error', error: 'string error' });
    expect(buildOtResponse(42)).toEqual({ status: 'error', error: '42' });
  });
});

describe('executeOT', () => {
  const ops: Operation[] = [{ op: 'replace', path: '/el-btn-0/clicked', value: true }];

  it('resolves to success when executor succeeds', async () => {
    const executor = async () => {};
    const result = await executeOT(ops, executor, new AbortController().signal);
    expect(result).toEqual({ status: 'success' });
  });

  it('resolves to canceled when executor throws AbortError', async () => {
    const executor = async () => { throw new DOMException('Aborted', 'AbortError'); };
    const result = await executeOT(ops, executor, new AbortController().signal);
    expect(result).toEqual({ status: 'canceled' });
  });

  it('resolves to error when executor throws generic Error', async () => {
    const executor = async () => { throw new Error('fail'); };
    const result = await executeOT(ops, executor, new AbortController().signal);
    expect(result).toEqual({ status: 'error', error: 'fail' });
  });

  it('passes the signal through to the executor', async () => {
    const signal = new AbortController().signal;
    let capturedSignal: AbortSignal | null = null;
    const executor = async (_ops: Operation[], sig: AbortSignal) => { capturedSignal = sig; };

    await executeOT(ops, executor, signal);
    expect(capturedSignal).toBe(signal);
  });
});
