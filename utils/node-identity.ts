import { NodeId } from './scene';

/**
 * Two-tier stable identity.
 *
 * Primary: a WeakMap<Element, NodeId> (the "mirror") so a node keeps its id
 * across reflow and attribute churn. Fallback: when a framework unmounts and
 * remounts the same logical control (new element), re-key by a semantic
 * signature (role + accessible name + structural path) so the NodeId re-attaches
 * to the new element.
 *
 * NOTE: this mirror is a minimal stand-in. rrweb-snapshot's hardened Mirror
 * (shadow DOM / iframe edge cases) can be swapped in behind this interface.
 */
export class NodeIdMirror {
  private byElement = new WeakMap<Element, NodeId>();
  private bySignature = new Map<string, NodeId>();
  private seq = 0;

  /** Resolve (and if needed mint) a stable NodeId for an element. */
  idFor(el: Element, signature?: string): NodeId {
    const existing = this.byElement.get(el);
    if (existing) return existing;

    if (signature) {
      const prior = this.bySignature.get(signature);
      if (prior) {
        this.byElement.set(el, prior);
        return prior;
      }
    }

    const id = `n${++this.seq}`;
    this.byElement.set(el, id);
    if (signature) this.bySignature.set(signature, id);
    return id;
  }

  /** Current id if the element is already tracked, else undefined. */
  peek(el: Element): NodeId | undefined {
    return this.byElement.get(el);
  }
}

/** tag + nth-of-type chain to the root. Part of the cross-swap re-key signature. */
export function structuralPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 24) {
    let idx = 1;
    let sib = cur.previousElementSibling;
    while (sib) {
      if (sib.tagName === cur.tagName) idx++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(`${cur.tagName.toLowerCase()}:${idx}`);
    cur = cur.parentElement;
  }
  return parts.join('/');
}

/** Semantic signature for cross-swap re-keying. */
export function semanticSignature(
  role: string,
  name: string | undefined,
  path: string,
): string {
  return `${role}|${name ?? ''}|${path}`;
}
