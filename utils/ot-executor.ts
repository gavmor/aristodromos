import type { Operation } from 'fast-json-patch';

// ---------------------------------------------------------------------------
// Cancelable OT application — mirrors demo.ts applyOperationalTransformAsync
// ---------------------------------------------------------------------------

/**
 * Resolve a JSON Patch path back to a DOM element.
 * First tries the elementMap (synthetic keys like "el-btn-0"),
 * then falls back to /#id and /tag.classname formats.
 */
export function resolvePatchPath(
  path: string,
  elementMap?: Map<string, Element>,
): Element | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  // Try elementMap first — keys like "el-btn-0" from buildAXTree()
  if (elementMap?.has(parts[0])) return elementMap.get(parts[0])!;

  // Fallback: /#id lookup from "/#btn-1/clicked" → id="btn-1"
  if (path.startsWith('/#')) {
    const id = parts[0].slice(1); // "#btn-1" → "btn-1"
    return document.getElementById(id);
  }

  // Fallback: DOM selector from first path segment
  const seg = parts[0];
  const tagMatch = seg.match(/^([a-zA-Z0-9-]+)/);
  if (tagMatch) {
    const selector = seg.replace(/^[a-zA-Z0-9-]+/, tagMatch[0]);
    return document.querySelector(selector);
  }

  return null;
}

/**
 * Apply a single OT operation to the DOM.
 */
export function applyOperation(op: Operation, elementMap?: Map<string, Element>): boolean {
  try {
    const el = resolvePatchPath(op.path, elementMap);
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
  elementMap?: Map<string, Element>,
): Promise<void> {
  if (abortSignal.aborted) throw new DOMException('OT application canceled', 'AbortError');

  console.log(`[OT] Starting cancelable OT application (${otPayload.length} operations)...`);

  for (const patch of otPayload) {

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(resolve, 800);
      abortSignal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        reject(new DOMException('OT application canceled', 'AbortError'));
      });
    });

    const ok = applyOperation(patch, elementMap);
    console.log(`[OT] -> [DOM Execution] ${patch.op} at ${patch.path}: ${ok ? 'OK' : 'FAILED'}`);
  }

  console.log('[OT] OT application complete.');
}
