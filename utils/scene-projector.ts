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
  /** elements whose children were inserted or removed: their outline needs re-placing */
  private childListTargets = new Set<Element>();
  private globalPerception = new Map<string, GlobalPerception>();
  private scheduled = false;
  private lastFocused: Element | null = null;
  private teardown: Array<() => void> = [];
  /** kept so elements added after start() are watched for viewport changes too */
  private viewportObserver: IntersectionObserver | undefined;

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
    // Every element is visited once: by the place() of its nearest projected ancestor.
    this.place(null);
    for (const id of Object.keys(this.scene.nodes)) {
      const el = this.mirror.elementFor(id);
      if (el) this.place(el);
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
    // Parents whose list of projected children may have changed; null is the frame's top.
    const reflow = new Set<Element | null>();
    for (const target of this.childListTargets) if (target.isConnected) reflow.add(this.selfOrAncestor(target));
    this.childListTargets.clear();
    const placementChanged: Element[] = [];

    for (const el of this.dirty) {
      const node = el.isConnected ? parseNode(el, ctx) : null;
      const id = this.mirror.peek(el);
      if (!id) continue;
      const prev = this.scene.nodes[id];

      if (!node) {
        if (prev) {
          delete this.scene.nodes[id];
          ops.push({ op: 'remove', path: `/nodes/${id}` });
          // Still on the page but no longer projected: its children move up a level.
          if (el.isConnected) placementChanged.push(el);
        }
        continue;
      }

      const overlay = this.globalPerception.get(id);
      if (overlay) node.perception = { ...node.perception, ...overlay };

      if (!prev) {
        this.scene.nodes[id] = node;
        ops.push({ op: 'add', path: `/nodes/${id}`, value: node });
        placementChanged.push(el);
        continue;
      }
      // Parsing knows nothing of placement: keep it, and let place() change it.
      node.order = prev.order;
      if (prev.parent !== undefined) node.parent = prev.parent;
      for (const sub of compare(prev, node)) {
        ops.push({ ...sub, path: `/nodes/${id}${sub.path}` });
      }
      this.scene.nodes[id] = node;
    }
    this.dirty.clear();

    // A node that appeared or vanished changes its ancestor's children, and a
    // newly projected one may adopt nodes that sat directly under that ancestor.
    for (const el of placementChanged) {
      reflow.add(this.projectedAncestor(el));
      if (this.isProjected(el)) reflow.add(el);
    }
    for (const parent of reflow) this.place(parent, ops);

    if (ops.length) this.deps.emit({ kind: 'patch', documentId: this.scene.documentId, ops });
  }

  private isProjected(el: Element): boolean {
    const id = this.mirror.peek(el);
    return id !== undefined && this.scene.nodes[id] !== undefined;
  }

  private projectedAncestor(el: Element): Element | null {
    for (let cur = el.parentElement; cur; cur = cur.parentElement) if (this.isProjected(cur)) return cur;
    return null;
  }

  private selfOrAncestor(el: Element): Element | null {
    return this.isProjected(el) ? el : this.projectedAncestor(el);
  }

  /** The projected elements directly under `parent` (null: the frame's top), in document order. */
  private projectedChildren(parent: Element | null): Element[] {
    const found: Element[] = [];
    const visit = (el: Element): void => {
      for (const child of Array.from(el.children)) {
        if (this.isProjected(child)) found.push(child);
        else visit(child); // an unprojected wrapper is transparent
      }
    };
    if (parent) visit(parent);
    else {
      const top = this.deps.root.documentElement;
      if (top && this.isProjected(top)) found.push(top);
      else if (top) visit(top);
    }
    return found;
  }

  /** Give each child of `parent` its parent id and sibling position, recording what changed. */
  private place(parent: Element | null, ops?: Operation[]): void {
    const parentId = parent ? this.mirror.peek(parent) : undefined;
    // No longer projected: its ancestor is being re-placed instead.
    if (parent && !this.isProjected(parent)) return;
    this.projectedChildren(parent).forEach((child, order) => {
      const id = this.mirror.peek(child);
      if (!id) return;
      const node = this.scene.nodes[id];
      if (node.order !== order) {
        node.order = order;
        ops?.push({ op: 'replace', path: `/nodes/${id}/order`, value: order });
      }
      if (node.parent === parentId) return;
      if (parentId === undefined) {
        delete node.parent;
        ops?.push({ op: 'remove', path: `/nodes/${id}/parent` });
      } else {
        ops?.push({ op: node.parent === undefined ? 'add' : 'replace', path: `/nodes/${id}/parent`, value: parentId });
        node.parent = parentId;
      }
    });
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
      this.viewportObserver = io;
      this.teardown.push(() => {
        io.disconnect();
        this.viewportObserver = undefined;
      });
    }

    const view = doc.defaultView;
    if (view) {
      // A control's value is an IDL property, not an attribute: writing it fires
      // NO mutation record, so MutationObserver alone leaves every `value` in
      // the Scene frozen at its initial state. For a model whose only memory is
      // the page, that is fatal — it re-fills fields it already filled, forever.
      // These two events are the missing source of truth for state nodes.
      const onValueChange = (event: Event): void => {
        if (event.target instanceof Element) this.markDirty(event.target);
      };
      for (const type of ['input', 'change']) {
        view.addEventListener(type, onValueChange, true);
      }
      this.teardown.push(() => {
        for (const type of ['input', 'change']) {
          view.removeEventListener(type, onValueChange, true);
        }
      });

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
      if (rec.type === 'childList' && rec.target instanceof Element) this.childListTargets.add(rec.target);
      // A record names only the ROOT of an added or removed subtree. Pages that
      // render a whole section at once (a story passage, a framework re-render)
      // put everything that matters below it, so walk it.
      for (const n of Array.from(rec.addedNodes)) {
        if (!(n instanceof Element)) continue;
        for (const el of [n, ...Array.from(n.querySelectorAll('*'))]) {
          this.markDirty(el);
          this.viewportObserver?.observe(el);
          if (isDialogEl(el)) modalChanged = true;
        }
      }
      for (const n of Array.from(rec.removedNodes)) {
        if (!(n instanceof Element)) continue;
        for (const el of [n, ...Array.from(n.querySelectorAll('*'))]) {
          // Only what was projected has anything to remove.
          if (this.mirror.peek(el)) this.markDirty(el);
          this.viewportObserver?.unobserve(el);
          if (isDialogEl(el)) modalChanged = true;
        }
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
