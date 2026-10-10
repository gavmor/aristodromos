// Mock deciders. These stand in for utils/brain.ts so the eval harness itself
// can be measured: no provider, no network, no nondeterminism.
//
// The two brains bracket the behaviour a steerability gate must tell apart:
// one is always right, one is right only by luck. A harness that cannot
// separate them is not measuring steering.
import { isActionNode, isReachable } from '../../utils/action-schema';
import type { NodeId, Scene } from '../../utils/scene';
import { STEERABILITY_CASES } from './steerability-cases';

export interface BrainDecision {
  actionId: NodeId;
  confidence: number;
}

/** Same shape as the real decide(): a function of the observation and the goal. */
export type Brain = (scene: Scene, goal: string) => BrainDecision;

/** Reachable triggers, in Scene order — the choice set offered to a brain. */
export function offeredActions(scene: Scene): NodeId[] {
  return Object.values(scene.nodes)
    .filter(isActionNode)
    .filter(isReachable)
    .map((n) => n.id);
}

const ANSWER_KEY = new Map<string, NodeId>(
  STEERABILITY_CASES.map((c) => [c.scene.documentId, c.correctActionId]),
);

/**
 * Perfect steering, faked. Reads the answer key rather than the page, which is
 * the point: it is a KNOWN-GOOD signal the gate must pass at 3/3. If it ever
 * fails, the harness is broken, not the policy.
 */
export const deterministicBrain: Brain = (scene) => {
  const actionId = ANSWER_KEY.get(scene.documentId);
  if (!actionId) throw new Error(`no answer key for document ${scene.documentId}`);
  return { actionId, confidence: 1 };
};

/** mulberry32 — seeded so "random" is still reproducible in CI. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * No steering at all: uniform over the offered actions. This is the KNOWN-BAD
 * signal. A gate that green-lights this is green-lighting everything.
 */
export function makeRandomBrain(seed: number): Brain {
  const next = rng(seed);
  return (scene) => {
    const offered = offeredActions(scene);
    const actionId = offered[Math.floor(next() * offered.length)];
    if (!actionId) throw new Error(`scene ${scene.documentId} affords no action`);
    return { actionId, confidence: 1 / offered.length };
  };
}

export const randomBrain: Brain = makeRandomBrain(0xc0ffee);

/** Human-readable label for a node, used when handing a decision to a grader. */
export function actionLabel(scene: Scene, id: NodeId): string {
  const node = scene.nodes[id];
  return node?.name ?? id;
}
