import type { Operation } from 'fast-json-patch';

// ---------------------------------------------------------------------------
// Cancelable OT application — mirrors demo.ts applyOperationalTransformAsync
// ---------------------------------------------------------------------------

/**
 * Resolve a JSON Patch path back to a DOM element.
 * Supports /#id and /tag.classname formats.
 */
export function resolvePatchPath(path: string): Element | null {
  if (path.startsWith('/#')) {
    return document.getElementById(path.slice(2));
  }
  // Try matching by tag + class from the first segment
  const parts = path.split('/').filter(Boolean);
  if (parts.length > 0) {
    const seg = parts[0];
    const tagMatch = seg.match(/^([a-zA-Z0-9-]+)/);
    if (tagMatch) {
      const selector = seg.replace(/^[a-zA-Z0-9-]+/, tagMatch[0]);
      return document.querySelector(selector);
    }
  }
  return null;
}

/**
 * Apply a single OT operation to the DOM.
 */
export function applyOperation(op: Operation): boolean {
  try {
    const el = resolvePatchPath(op.path);
    if (!el) return false;

    switch (op.op) {
      case 'replace':
        if (op.path.endsWith('/clicked')) {
          (el as HTMLElement).click();
        } else if (op.path.endsWith('/value')) {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.value = String(op.value ?? '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Apply a batch of OT operations cancelably.
 * Each operation is staggered by 800ms for observability.
 *
 * @throws DOMException('AbortError') if aborted mid-batch
 */
export async function applyOperationalTransformAsync(
  otPayload: Operation[],
  abortSignal: AbortSignal,
): Promise<void> {
  console.log(`[OT] Starting cancelable OT application (${otPayload.length} operations)...`);

  for (const patch of otPayload) {
    if (abortSignal.aborted) throw new DOMException('OT application canceled', 'AbortError');

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(resolve, 800);
      abortSignal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        reject(new DOMException('OT application canceled', 'AbortError'));
      });
    });

    const ok = applyOperation(patch);
    console.log(`[OT] -> [DOM Execution] ${patch.op} at ${patch.path}: ${ok ? 'OK' : 'FAILED'}`);
  }

  console.log('[OT] OT application complete.');
}
