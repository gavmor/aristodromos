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

/** One row of the run evidence log: what the brain saw and what it emitted. */
export interface TurnRecord {
  tick: number;
  at: number;
  documentId: string;
  url: string;
  /** JSON-Patch ops folded in since the previous turn — the Scene delta volume */
  opsSinceLastTurn: number;
  /** node ids the schema admitted this turn */
  afforded: { state: string[]; trigger: string[] };
  satisfied: string;
  remaining: string;
  actions: PlanAction[];
  ms: number;
  error?: string;
}
