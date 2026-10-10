// Mock deciders. These stand in for the real brain (`utils/brain.ts`) so the
// eval harness can be measured WITHOUT a model, a provider, or a network call.
//
// The point of a pair is calibration. `deterministicBrain` is a perfect policy
// and `randomBrain` is a policy with no steering at all; a harness worth adopting
// must separate them. A harness that greens both is measuring nothing, and you
// only find that out by running the floor as well as the ceiling.
import type { NodeId } from '../utils/scene';
import { offeredActionIds, type SteerabilityCase } from './steerability';

export interface BrainChoice {
  actionId: NodeId;
  /** the policy's own belief, graded separately from correctness */
  confidence: number;
}

/** Same shape as the real decision edge: (observation, goal) -> one discrete choice. */
export type Brain = (fixture: SteerabilityCase, goal: string) => BrainChoice;

/** Ceiling: always the goal-correct trigger. Should score 3/3 on every case. */
export const deterministicBrain: Brain = (fixture) => ({
  actionId: fixture.correctActionId,
  confidence: 1,
});

/** mulberry32 — a seeded PRNG, so the floor run is reproducible and citable. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_SEED = 20261010;

/**
 * Floor: uniform over the triggers the Scene actually offers. Unseeded would be
 * flaky in CI and unquotable in a findings doc, so the seed is explicit.
 */
export function makeRandomBrain(seed: number = DEFAULT_SEED): Brain {
  const next = mulberry32(seed);
  return (fixture) => {
    const options = offeredActionIds(fixture.scene);
    const picked = options[Math.floor(next() * options.length)];
    return { actionId: picked, confidence: 1 / options.length };
  };
}

export type BrainName = 'deterministic' | 'random';

export function makeBrain(name: BrainName, seed: number = DEFAULT_SEED): Brain {
  return name === 'deterministic' ? deterministicBrain : makeRandomBrain(seed);
}
