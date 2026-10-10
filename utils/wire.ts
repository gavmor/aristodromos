// The Port contract between the two halves.
//
// One long-lived `browser.runtime.connect` channel per content-script lifetime.
// Up: a Scene snapshot on connect/navigation, then fast-json-patch deltas.
// Down: a plan to actuate. Port disconnect IS the lifecycle end — there is no
// separate teardown message to lose.
//
// Deliberately absent: watermarks, acks, sequence numbers. The loop is
// at-least-once and memoryless; it closes through the WORLD, not through the
// channel. A re-applied plan converges because `setState` is convergent and the
// next observation reports the truth either way.
import type { ScenePatch } from './scene';
import type { PlanAction } from './action-schema';

export const AGENT_PORT = 'aristodromos-agent';

/** content -> background */
export type UpMessage = ScenePatch;

/** background -> content */
export type DownMessage =
  | { kind: 'plan'; documentId: string; tick: number; satisfied: string; remaining: string; actions: PlanAction[] }
  | { kind: 'idle'; documentId: string; tick: number; reason: string };

/**
 * The DevTools panel's read-only view of one tab's Scene. The panel connects,
 * names its tab, and from then on receives exactly what that tab's frames send
 * up, each tagged with its frame: every frame's current Scene first, then every
 * snapshot and patch, and word when a frame goes away. The panel composes them
 * the same way the background does (TabScene).
 */
export const INSPECT_PORT = 'aristodromos-inspect';

/** panel -> background, once per connection */
export interface InspectRequest {
  kind: 'inspect';
  tabId: number;
}

/** background -> panel */
export type InspectMessage = { frameId: number; message: ScenePatch } | { frameId: number; gone: true };

/** A decision awaiting the brain; published so a UI can show the wait. */
export interface PendingDecision {
  tick: number;
  startedAt: number;
  /** stamped by the background, as on `TurnRecord` */
  tabId?: number;
  documentId: string;
  url: string;
}

/** One row of the run evidence log: what the brain saw and what it emitted. */
export interface TurnRecord {
  tick: number;
  at: number;
  /** the tab whose content script produced the Scene; stamped by the background */
  tabId?: number;
  documentId: string;
  url: string;
  /** JSON-Patch ops folded in since the previous turn — the Scene delta volume */
  opsSinceLastTurn: number;
  /** node ids the schema admitted this turn */
  afforded: { state: string[]; trigger: string[] };
  satisfied: string;
  remaining: string;
  actions: PlanAction[];
  /** the brain judged the goal met on this Scene */
  done?: boolean;
  /** which brain decided, and — on a fallback — why it was handed over */
  via?: string;
  /** the deciding brain's calibrated confidence, when it reports one */
  confidence?: number;
  ms: number;
  error?: string;
}
