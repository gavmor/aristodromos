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
  /** reverse index for the down-edge; weak so it never pins a detached node */
  private byId = new Map<NodeId, WeakRef<Element>>();
  private seq = 0;

  /** Resolve (and if needed mint) a stable NodeId for an element. */
  idFor(el: Element, signature?: string): NodeId {
    const existing = this.byElement.get(el);
    if (existing) return existing;

    if (signature) {
      const prior = this.bySignature.get(signature);
      // Re-attach only for a remount: the element that held the id must be
      // gone. A live one keeps it, or two elements would share a NodeId and a
      // plan meant for one would land on the other.
      if (prior && !this.elementFor(prior)) {
        this.byElement.set(el, prior);
        this.byId.set(prior, new WeakRef(el));
        return prior;
      }
    }

    const id = `n${++this.seq}`;
    this.byElement.set(el, id);
    this.byId.set(id, new WeakRef(el));
    if (signature) this.bySignature.set(signature, id);
    return id;
  }

  /** Current id if the element is already tracked, else undefined. */
  peek(el: Element): NodeId | undefined {
    return this.byElement.get(el);
  }

  /**
   * The live element behind a NodeId, for actuation. Returns undefined once the
   * element is gone or detached — the honest answer when a plan arrives for a
   * node the page has since replaced.
   */
  elementFor(id: NodeId): Element | undefined {
    const el = this.byId.get(id)?.deref();
    return el?.isConnected ? el : undefined;
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
