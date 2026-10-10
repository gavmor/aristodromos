import { compare, Operation } from 'fast-json-patch';
import { Perception, Scene, SceneNode, ScenePatch } from './scene';
import { NodeIdMirror } from './node-identity';
import { parseNode, ParseContext } from './semantic-parser';

/** The subset of perception that is global (not derivable from the element alone). */
type GlobalPerception = Partial<Pick<Perception, 'inViewport' | 'occluded' | 'inertByModal'>>;

export interface ProjectorDeps {
  root: Document;
  emit: (patch: ScenePatch) => void;
  /** Flush scheduler; defaults to requestAnimationFrame. Inject for tests. */
  schedule?: (cb: () => void) => void;
}

function newDocumentId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `doc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function defaultSchedule(cb: () => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  if (raf) raf(cb);
  else setTimeout(cb, 0);
}

function isDialogEl(el: Element): boolean {
  const role = el.getAttribute('role');
  return el.tagName.toLowerCase() === 'dialog' || role === 'dialog' || role === 'alertdialog';
}

/**
 * The projection engine. Holds an in-memory Scene, a single dirty-set accumulator
 * fed by BOTH DOM mutations (local perception) and global-event sources
 * (inViewport / occluded / inertByModal / focus), and flushes once per frame into
 * targeted JSON-Patch ops — so the up-edge stream stays proportional to what
 * actually changed.
 */
export class SceneProjector {
  private scene: Scene;
  private mirror = new NodeIdMirror();
  private dirty = new Set<Element>();
  private globalPerception = new Map<string, GlobalPerception>();
  private scheduled = false;
  private lastFocused: Element | null = null;
  private teardown: Array<() => void> = [];

  constructor(private deps: ProjectorDeps) {
    const doc = deps.root;
    const view = doc.defaultView;
    this.scene = {
      documentId: newDocumentId(),
      url: doc.location?.href ?? '',
      title: doc.title ?? '',
      viewport: {
        w: view?.innerWidth ?? 0,
        h: view?.innerHeight ?? 0,
        scrollX: view?.scrollX ?? 0,
        scrollY: view?.scrollY ?? 0,
      },
      nodes: {},
    };
  }

  get current(): Scene {
    return this.scene;
  }

  /** The live element behind a NodeId — the down-edge's only way back to DOM. */
  elementFor(id: string): Element | undefined {
    return this.mirror.elementFor(id);
  }

  /** The node as last projected, for its actuation recipe. */
  nodeOf(id: string): SceneNode | undefined {
    return this.scene.nodes[id];
  }

  /** Full walk → populate the scene → return a snapshot. */
  scan(): ScenePatch {
    const ctx: ParseContext = { mirror: this.mirror };
    for (const el of Array.from(this.deps.root.querySelectorAll('*'))) {
      const node = parseNode(el, ctx);
      if (node) this.scene.nodes[node.id] = node;
    }
    return { kind: 'snapshot', scene: this.scene };
  }

  snapshot(): ScenePatch {
    return { kind: 'snapshot', scene: this.scene };
  }

  markDirty(el: Element): void {
    this.dirty.add(el);
    this.requestFlush();
  }

  /** Record a global perception fact for an element and queue its re-projection. */
  setGlobalPerception(el: Element, patch: GlobalPerception): void {
    const id = this.mirror.idFor(el);
    this.globalPerception.set(id, { ...this.globalPerception.get(id), ...patch });
    this.markDirty(el);
  }

  private requestFlush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    (this.deps.schedule ?? defaultSchedule)(() => this.flush());
  }

  /** Re-project the dirty set, overlay global perception, emit targeted ops. */
  flush(): void {
    this.scheduled = false;
    const ctx: ParseContext = { mirror: this.mirror };
    const ops: Operation[] = [];

    for (const el of this.dirty) {
      const node = el.isConnected ? parseNode(el, ctx) : null;
      const id = this.mirror.peek(el);
      if (!id) continue;
      const prev = this.scene.nodes[id];

      if (!node) {
        if (prev) {
          delete this.scene.nodes[id];
          ops.push({ op: 'remove', path: `/nodes/${id}` });
        }
        continue;
      }

      const overlay = this.globalPerception.get(id);
      if (overlay) node.perception = { ...node.perception, ...overlay };

      if (!prev) {
        this.scene.nodes[id] = node;
        ops.push({ op: 'add', path: `/nodes/${id}`, value: node });
        continue;
      }
      for (const sub of compare(prev, node)) {
        ops.push({ ...sub, path: `/nodes/${id}${sub.path}` });
      }
      this.scene.nodes[id] = node;
    }

    this.dirty.clear();
    if (ops.length) this.deps.emit({ kind: 'patch', documentId: this.scene.documentId, ops });
  }

  /** Wire the live sources. Each is guarded for API availability (jsdom etc.). */
  start(): void {
    const doc = this.deps.root;

    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver((recs) => this.onMutations(recs));
      mo.observe(doc.body ?? doc.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      this.teardown.push(() => mo.disconnect());
    }

    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) this.setGlobalPerception(e.target, { inViewport: e.isIntersecting });
      });
      for (const el of Array.from(doc.querySelectorAll('*'))) io.observe(el);
      this.teardown.push(() => io.disconnect());
    }

    const view = doc.defaultView;
    if (view) {
      const onFocus = (): void => {
        const active = doc.activeElement;
        if (this.lastFocused && this.lastFocused !== active) this.markDirty(this.lastFocused);
        if (active && active !== doc.body) this.markDirty(active);
        this.lastFocused = active;
      };
      view.addEventListener('focusin', onFocus);
      view.addEventListener('focusout', onFocus);
      this.teardown.push(() => {
        view.removeEventListener('focusin', onFocus);
        view.removeEventListener('focusout', onFocus);
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const onSettle = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => this.recomputeOcclusion(), 150);
      };
      view.addEventListener('scroll', onSettle, true);
      view.addEventListener('resize', onSettle);
      this.teardown.push(() => {
        view.removeEventListener('scroll', onSettle, true);
        view.removeEventListener('resize', onSettle);
      });
    }
  }

  stop(): void {
    for (const off of this.teardown) off();
    this.teardown = [];
  }

  private onMutations(records: MutationRecord[]): void {
    let modalChanged = false;
    for (const rec of records) {
      if (rec.target instanceof Element) this.markDirty(rec.target);
      for (const n of Array.from(rec.addedNodes)) {
        if (n instanceof Element) {
          this.markDirty(n);
          if (isDialogEl(n)) modalChanged = true;
        }
      }
      for (const n of Array.from(rec.removedNodes)) {
        if (n instanceof Element && isDialogEl(n)) modalChanged = true;
      }
    }
    if (modalChanged) this.reflagModal();
  }

  /** On a modal open/close, bulk-flag every tracked node's inertByModal. */
  reflagModal(): void {
    const modal = this.deps.root.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
    for (const el of Array.from(this.deps.root.querySelectorAll('*'))) {
      if (!this.mirror.peek(el)) continue;
      const inert = modal !== null && modal !== el && !modal.contains(el);
      this.setGlobalPerception(el, { inertByModal: inert });
    }
  }

  /** Expensive: only run on scroll/resize settle, only for in-viewport nodes. */
  recomputeOcclusion(): void {
    const root = this.deps.root;
    if (typeof root.elementFromPoint !== 'function') return;
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const id = this.mirror.peek(el);
      if (!id) continue;
      if (!this.globalPerception.get(id)?.inViewport) continue;
      const r = el.getBoundingClientRect();
      const hit = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      this.setGlobalPerception(el, { occluded: hit !== null && hit !== el && !el.contains(hit) });
    }
  }
}
