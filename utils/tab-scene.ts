// One tab's Scene, composed from its frames.
//
// Every frame — the top document and each iframe — runs its own content script
// and projector and sends its own snapshot/patch stream. Each stream folds into
// its own SceneStore, exactly as a single page always did; this composes them
// into the one Scene the brain sees. Node ids are namespaced by frame, so
// `f0.n12` is node n12 of the top frame and `f14.n3` node n3 of frame 14, and
// every id-valued field (relations, a submit's form, focus, modal) is re-keyed
// the same way. A plan's actions route back by that prefix.
//
// Frames smaller than MIN_FRAME_SIDE on either side (tracking pixels, hidden or
// collapsed iframes) are left out; the top frame never is.
import { SceneStore } from './scene-store';
import type { FrameInfo, NodeId, Relations, Scene, SceneNode, ScenePatch } from './scene';

export const MIN_FRAME_SIDE = 100;

/** A composed Scene always says which frames it was built from. */
export type ComposedScene = Scene & { frames: Record<string, FrameInfo> };

export const frameNodeId = (frameId: number, id: NodeId): NodeId => `f${frameId}.${id}`;

/** `f14.n3` -> frame 14, node n3. Undefined for an id no frame owns. */
export function splitNodeId(id: NodeId): { frameId: number; nodeId: NodeId } | undefined {
  const match = /^f(\d+)\.(.+)$/.exec(id);
  return match ? { frameId: Number(match[1]), nodeId: match[2] } : undefined;
}

function rekey(frameId: number, node: SceneNode): SceneNode {
  const at = (id: NodeId): NodeId => frameNodeId(frameId, id);
  const relations = Object.fromEntries(
    Object.entries(node.relations).map(([key, value]) => [key, Array.isArray(value) ? value.map(at) : at(value)]),
  ) as Relations;
  const copy = { ...node, id: at(node.id), relations };
  if ('submits' in copy && copy.submits) copy.submits = { ...copy.submits, formId: at(copy.submits.formId) };
  return copy;
}

export class TabScene {
  private stores = new Map<number, SceneStore>();
  /** frames whose last message was a `settled` re-announcement */
  private settledFrames = new Set<number>();
  private composed: ComposedScene | null = null;
  private stale = true;

  /** Fold one frame's message in. True if the tab's Scene changed. */
  ingest(frameId: number, message: ScenePatch): boolean {
    let store = this.stores.get(frameId);
    if (!store) {
      store = new SceneStore();
      this.stores.set(frameId, store);
    }
    if (!store.ingest(message)) return false;
    if (message.kind === 'snapshot' && message.settled) this.settledFrames.add(frameId);
    else this.settledFrames.delete(frameId);
    this.stale = true;
    return true;
  }

  /** The frame is gone: navigated away, removed, or its port closed. True if it was here. */
  drop(frameId: number): boolean {
    this.settledFrames.delete(frameId);
    if (!this.stores.delete(frameId)) return false;
    this.stale = true;
    return true;
  }

  /** The document a frame currently shows, before composition. */
  documentOf(frameId: number): string | undefined {
    return this.stores.get(frameId)?.current?.documentId;
  }

  /** True when every frame's last word was "already decided idle on exactly this". */
  get settled(): boolean {
    return this.stores.size > 0 && [...this.stores.keys()].every((frameId) => this.settledFrames.has(frameId));
  }

  /** Each frame's own Scene, un-composed, for a replica elsewhere to rebuild from. */
  get frames(): [number, Scene][] {
    return [...this.stores].flatMap(([frameId, store]) => (store.current ? [[frameId, store.current] as [number, Scene]] : []));
  }

  get current(): ComposedScene | null {
    if (this.stale) {
      this.composed = this.compose();
      this.stale = false;
    }
    return this.composed;
  }

  private compose(): ComposedScene | null {
    const included = this.frames
      .filter(([frameId, scene]) => frameId === 0 || (scene.viewport.w >= MIN_FRAME_SIDE && scene.viewport.h >= MIN_FRAME_SIDE))
      .sort(([a], [b]) => a - b);
    if (included.length === 0) return null;

    // Until the top frame (re)connects after a navigation, a child stands in
    // for the page-level fields.
    const [topId, top] = included[0];
    const nodes: Record<NodeId, SceneNode> = {};
    for (const [frameId, scene] of included) {
      for (const node of Object.values(scene.nodes)) {
        const rekeyed = rekey(frameId, node);
        nodes[rekeyed.id] = rekeyed;
      }
    }
    return {
      // Any frame showing a new document is a new world for the whole tab.
      documentId: included.map(([, scene]) => scene.documentId).join('+'),
      url: top.url,
      title: top.title,
      lang: top.lang,
      viewport: top.viewport,
      focusedId: top.focusedId && frameNodeId(topId, top.focusedId),
      activeModalId: top.activeModalId && frameNodeId(topId, top.activeModalId),
      nodes,
      frames: Object.fromEntries(
        included.map(([frameId, scene]) => [frameId, { documentId: scene.documentId, url: scene.url, title: scene.title }]),
      ),
    };
  }
}
