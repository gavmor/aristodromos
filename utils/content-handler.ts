import type { Operation } from 'fast-json-patch';
import { isAbortError } from './messaging';

// ---------------------------------------------------------------------------
// EXECUTE_OT response payload — testable decision
// ---------------------------------------------------------------------------

export interface OtResponse {
  status: 'success' | 'canceled' | 'error';
  error?: string;
}

/**
 * Pure function: given the result of executing OT operations,
 * build the appropriate response payload.
 *
 * Testable without DOM or browser APIs — just pass the error.
 */
export function buildOtResponse(error?: unknown): OtResponse {
  if (!error) return { status: 'success' };

  if (isAbortError(error)) return { status: 'canceled' };

  return {
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Async handler logic for EXECUTE_OT messages.
 * Extracted so the callback in content.ts is a one-liner.
 */
export async function executeOT(
  payload: Operation[],
  executor: (ops: Operation[], signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<OtResponse> {
  try {
    await executor(payload, signal);
    return { status: 'success' };
  } catch (err) {
    return buildOtResponse(err);
  }
}
