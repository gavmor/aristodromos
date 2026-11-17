// The confidence gate: a cheap brain decides first, a dearer one only when it
// must. No transport or model in here: any fast brain that reports a
// calibrated `confidence` (System One today) can sit in front of any slow
// `Brain`, and a gate is itself a `Brain`, so gates chain.
import type { Brain, BrainInput, Decision } from './decision';
import type { NodeId } from './scene';

/** A decision that says how sure it is, and may leave a free-text value open. */
export interface ScoredDecision extends Decision {
  confidence: number;
  /**
   * The target is decided — a setState on a free-text control — but the string
   * is not; `actions` is empty. The gate turns this into a `fillValue` call or a
   * hand-over to the slow brain.
   */
  needsValue?: NodeId;
}

export type ScoredBrain = (input: BrainInput) => Promise<ScoredDecision>;

/** The text for one control, or null when the filler has no answer. */
export type ValueFiller = (input: BrainInput, nodeId: NodeId) => Promise<{ value: string; via: string } | null>;

export interface GatedBrainOptions {
  fast: ScoredBrain;
  slow: Brain;
  /** confidence at or above which the fast decision is emitted unreviewed */
  threshold: number;
  /**
   * Writes just the missing string when the fast brain is sure of its target.
   * Absent, a value that is needed goes to the slow brain with the whole Scene.
   */
  fillValue?: ValueFiller;
}

const slowVia = (decision: Decision): string => decision.via ?? 'slow';

/**
 * The gate only routes. It never edits a confident fast decision, and never
 * asks the slow brain to ratify one. In order:
 *   1. the fast brain failed (server down, bad shape): the slow brain decides,
 *      reason in `via` — an optional accelerator must not stop the agent;
 *   2. nothing afforded: a fact about the Scene, returned as is;
 *   3. below threshold: the slow brain decides, even when a value was needed —
 *      an unsure target is not worth filling;
 *   4. sure, and a value is needed: `fillValue` writes it; with no filler, or no
 *      answer from it, the slow brain decides;
 *   5. sure and complete: emitted.
 * On a hand-over `confidence` stays the fast brain's: it is the measurement
 * that explains the fallback, while `via` records who decided.
 */
export function createGatedBrain({ fast, slow, threshold, fillValue }: GatedBrainOptions): Brain {
  return async (input) => {
    let decision: ScoredDecision;
    try {
      decision = await fast(input);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const fallback = await slow(input);
      return { ...fallback, via: `${slowVia(fallback)} (fast brain failed: ${why})` };
    }

    if (!decision.decided) return decision;

    const handOver = async (reason: string): Promise<Decision> => {
      const fallback = await slow(input);
      return { ...fallback, confidence: decision.confidence, via: `${decision.via}->${slowVia(fallback)} (${reason})` };
    };

    if (decision.confidence < threshold) return handOver('low confidence');

    const nodeId = decision.needsValue;
    if (nodeId === undefined) return decision;

    const filled = fillValue && (await fillValue(input, nodeId));
    if (!filled) return handOver(`needs a value for ${nodeId}`);
    const { needsValue: _filled, ...rest } = decision;
    return {
      ...rest,
      actions: [{ kind: 'setState', nodeId, value: filled.value }],
      via: `${decision.via}+${filled.via} (value for ${nodeId})`,
    };
  };
}
