// Mock deciders — the "agentic components" under test, with the agency removed.
//
// Part of the SHARED PROTOCOL (identical across all four eval spikes). No
// network, no provider, no tokens: the point of the bake-off is to compare EVAL
// HARNESSES, and a real model would make every run a measurement of the model
// instead. These two brains bracket the possible outcomes — one that is always
// right and one that is right only by luck — so we can prove a harness
// DISCRIMINATES rather than merely goes green.
import { offeredActions, type SteerabilityCase } from './steerability';

export interface BrainChoice {
  actionId: string;
  /** self-reported, unused by the metric; carried so the protocol matches the real Decision shape */
  confidence: number;
}

export type Brain = (fixture: SteerabilityCase, goal: string) => BrainChoice;

/** Perfect steerability. The harness must score this 3/3. */
export const deterministicBrain: Brain = (fixture) => ({
  actionId: fixture.correctActionId,
  confidence: 1,
});

/**
 * Deterministic PRNG (mulberry32). A "random" baseline that is not reproducible
 * is a flaky CI gate, so the randomness is seeded and the whole suite is a pure
 * function of the seed.
 */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Chance steerability: uniform over the actions the Scene actually offers. */
export const makeRandomBrain = (seed: number): Brain => {
  const rand = mulberry32(seed);
  return (fixture) => {
    const offered = offeredActions(fixture.scene);
    return {
      actionId: offered[Math.floor(rand() * offered.length)],
      confidence: 1 / offered.length,
    };
  };
};

export const randomBrain: Brain = makeRandomBrain(1);
