// Scene model — a faithful, undistorted projection of the live page.
//
// Reports WHAT IS. No risk scoring, no masking, no policy — fidelity is the only
// goal. This is the content script's "up-edge" contract: the semantic simulacrum
// the background policy reasons over.
//
// Layering (see utils/ projection engine):
//   - identity + change detection : rrweb Mirror (WeakMap<Node,id>) + MutationObserver
//   - roles + accessible names    : dom-accessibility-api (W3C accname/role algorithms)
//   - semantic classification,    : BESPOKE (no prior art) — this module's model
//     perception probes, actuation
//   - wire deltas                 : fast-json-patch over `Scene`
import { Operation } from 'fast-json-patch';

/**
 * Stable across frames. Primary source is the rrweb Mirror id of the element that
 * anchors the node, so identity survives reflow and attribute churn for free.
 * When a framework unmounts+remounts the "same" logical control (new DOM node,
 * new mirror id), a secondary re-key by (role + accessible name + structural path)
 * re-attaches the same NodeId. Opaque to the policy.
 */
export type NodeId = string;

/**
 * How the policy must TREAT a node. Idempotency is ENCODED here, never asserted:
 * 'state' is convergent by construction; 'action' carries the raw signals
 * (action kind, href, form method) from which the policy judges reversibility.
 */
export type NodeCategory = 'state' | 'action' | 'content' | 'structure';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Perceptual truth — matches what a human can see and reach, not the raw DOM.
 * Disabled / occluded nodes are REPORTED, not omitted: "Submit exists but is
 * disabled" is signal the policy needs.
 */
export interface Perception {
  /** rendered: not display:none / visibility:hidden / opacity:0 / zero-size */
  visible: boolean;
  /** within the current scroll viewport */
  inViewport: boolean;
  /** covered by another element at its hit point */
  occluded: boolean;
  /** disabled or aria-disabled */
  disabled: boolean;
  /** is document.activeElement */
  focused: boolean;
  /** behind an open modal dialog -> currently unreachable */
  inertByModal: boolean;
  /** optional geometry; churns on scroll, so opt-in */
  bbox?: Rect;
}

/**
 * The orrery's "gearing": author-declared causal + containment structure.
 * Kept local to the node (not a global edges[] list) so a disclosure toggle that
 * rewrites aria-owns/controls emits a single op against /nodes/<id>. A receiver
 * that wants a graph builds the adjacency list in memory. All values are NodeIds.
 */
export interface Relations {
  /** nearest enclosing form / dialog / list / group / landmark */
  container?: NodeId;
  /** aria-labelledby */
  labelledBy?: NodeId[];
  /** aria-describedby (hints, error text) */
  describedBy?: NodeId[];
  /** aria-controls (tab->panel, disclosure->region) */
  controls?: NodeId[];
  /** aria-owns (logical children out of DOM order) */
  owns?: NodeId[];
}

/**
 * How the reconciler must DRIVE a node so framework-controlled widgets actually
 * respond. A bare .click() / .value= silently no-ops on many React widgets, and
 * under at-least-once semantics that degenerates into an infinite no-op retry.
 * Carried in the model so each node is self-describing.
 */
export interface Actuation {
  setStrategy?:
    | 'native-value'
    | 'react-setter'
    | 'select-option'
    | 'toggle-checked'
    | 'scroll';
  fireStrategy?:
    | 'native-click'
    | 'pointer-sequence'
    | 'submit-event'
    | 'enter-key';
  /** explicit event sequence to dispatch, in order */
  events?: string[];
}

interface BaseNode {
  id: NodeId;
  /** computed ARIA / semantic role (dom-accessibility-api getRole) */
  role: string;
  /** accessible name — full accname algorithm. The blindness fix. */
  name?: string;
  category: NodeCategory;
  relations: Relations;
  perception: Perception;
}

/** Convergent: has a settable value. Re-applying the same target is a no-op. */
export interface StateNode extends BaseNode {
  category: 'state';
  control: 'text' | 'boolean' | 'option' | 'range' | 'scroll' | 'aria';
  /** the LIVE mirror of the control's current value */
  value: string | boolean | number | null;
  /** for control 'option' */
  options?: { value: string; label: string }[];
  required?: boolean;
  readOnly?: boolean;
  /** aria-invalid / :invalid — validation truth */
  invalid?: boolean;
  placeholder?: string;
  /** for control 'range' */
  min?: number;
  max?: number;
  step?: number;
  actuation: Actuation;
}

/** Discrete effect when actuated. Carries raw reversibility SIGNALS, not a verdict. */
export interface ActionNode extends BaseNode {
  category: 'action';
  action: 'click' | 'submit' | 'navigate';
  /** for action 'navigate' — destination, factual */
  href?: string;
  /** for action 'submit' — the form it targets and its method, factual */
  submits?: { formId: NodeId; method: 'get' | 'post'; actionUrl?: string };
  /** aria-expanded (disclosure / menu) — state ON an action */
  expanded?: boolean;
  /** aria-pressed (toggle button) — state ON an action */
  pressed?: boolean;
  actuation: Actuation;
}

/** Readable information the policy must see to decide — not just controls. */
export interface ContentNode extends BaseNode {
  category: 'content';
  text: string;
  /** heading level */
  level?: number;
  /** aria-live: toasts, async errors, status announcements */
  live?: 'polite' | 'assertive';
}

/** Grouping / scoping context: forms, dialogs, landmarks, lists. */
export interface StructureNode extends BaseNode {
  category: 'structure';
  landmark?:
    | 'form'
    | 'dialog'
    | 'navigation'
    | 'main'
    | 'region'
    | 'list'
    | 'group'
    | 'tablist'
    | 'banner'
    | 'contentinfo';
  /** a modal dialog renders everything outside it inert */
  modal?: boolean;
  /** for forms */
  method?: 'get' | 'post';
  actionUrl?: string;
}

export type SceneNode = StateNode | ActionNode | ContentNode | StructureNode;

/**
 * The whole simulacrum. A FLAT node map keyed by stable id so each node sits at a
 * stable JSON-Patch path (/nodes/<id>): one DOM change = one targeted op, never a
 * tree reshuffle. The Relations fields reconstruct the graph on the receiver.
 */
export interface Scene {
  /**
   * Per page-LOAD identity of the WORLD. Changes on navigation, which forces a
   * fresh snapshot and tells the background to reset its derived view. This is
   * NOT a delivery-dedup / fencing epoch — it carries no exactly-once semantics.
   */
  documentId: string;
  url: string;
  title: string;
  lang?: string;
  viewport: { w: number; h: number; scrollX: number; scrollY: number };
  focusedId?: NodeId;
  /** if set, only nodes within this subtree are reachable */
  activeModalId?: NodeId;
  nodes: Record<NodeId, SceneNode>;
}

/** Up-edge payload: full Scene on connect / navigation, patches thereafter. */
export type ScenePatch =
  | { kind: 'snapshot'; scene: Scene }
  | { kind: 'patch'; documentId: string; ops: Operation[] };
