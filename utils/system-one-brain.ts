// The System-One brain, and the confidence gate that puts it in FRONT of the
// AI SDK one.
//
// The shape of the idea: a small, cheap, off-schema-impossible decider answers
// the question the loop actually asks — "which of these legal moves is next?" —
// in one forward pass, and reports how sure it is. The big model is kept, but
// it is now the exception path rather than the only path. Two things send a
// decision to it:
//
//   1. low confidence — the classifier is spreading mass across options, which
//      is exactly the situation a bigger model is worth paying for;
//   2. a value it structurally cannot produce — System-One picks among labels,
//      so it can choose a checkbox's true/false or a select's own option, but it
//      cannot invent the text of an email address.
//
// Everything here is additive: with no System-One configured the loop runs the
// AI SDK brain alone, exactly as before.
import {
  AI_SDK_BRAIN,
  nothingAfforded,
  type Brain,
  type BrainInput,
  type Decision,
} from './brain';
import {
  ACTION_QUESTION,
  DONE_QUESTION,
  buildActionQuestions,
  describeState,
} from './system-one-questions';
import { askSystemOne, isChoiceAnswer, isNoulAnswer, type FetchLike } from './system-one';

export const SYSTEM_ONE_BRAIN = 'system-one';

/**
 * A System-One decision also carries the two signals the gate reads.
 *
 * `confidence` is the SERVER's calibrated number, never recomputed here (see
 * system-one.ts). On a setState it is the minimum of the action question's
 * confidence and the value question's — a sure target with an unsure value is
 * not a sure decision.
 */
export interface SystemOneDecision extends Decision {
  confidence: number;
  /**
   * Set when the chosen move is a setState on a free-text control. The target is
   * decided; only the string is missing. `actions` is empty in this case, so a
   * System-One brain used ALONE would idle here — `createGatedBrain` is the
   * supported wiring, and it is what turns this flag into a fallback call.
   */
  needsValue?: string;
}

export type SystemOneBrain = (input: BrainInput) => Promise<SystemOneDecision>;

export interface SystemOneBrainOptions {
  /** server root; `/v1/systemone` is appended. Any Jev-compatible provider. */
  baseURL: string;
  model: string;
  /**
   * P(goal already met) at or above which the loop stops. High on purpose: a
   * premature stop ends the run, while a late stop costs one wasted tick that
   * the next observation corrects.
   */
  doneThreshold?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_DONE_THRESHOLD = 0.75;

/**
 * One classification over one Scene.
 *
 * `satisfied` and `remaining` come back empty, and that is the honest answer:
 * System-One is a classifier with no text channel, so it cannot narrate what it
 * read. The evidence it DOES produce — the chosen label and a calibrated
 * confidence — rides in `via` and `confidence` instead.
 */
export function createSystemOneBrain(options: SystemOneBrainOptions): SystemOneBrain {
  const doneThreshold = options.doneThreshold ?? DEFAULT_DONE_THRESHOLD;

  return async ({ scene, goal, signal }) => {
    const built = buildActionQuestions(scene);
    if (!built) return { ...nothingAfforded(SYSTEM_ONE_BRAIN), confidence: 0 };

    const response = await askSystemOne({
      baseURL: options.baseURL,
      fetchImpl: options.fetchImpl,
      signal,
      request: {
        model: options.model,
        state: describeState(scene, goal),
        questions: built.questions,
      },
    });

    const done = response.answers[DONE_QUESTION];
    if (isNoulAnswer(done) && done.noul >= doneThreshold) {
      return { decided: true, via: SYSTEM_ONE_BRAIN, confidence: done.noul, satisfied: '', remaining: '', actions: [] };
    }

    const chosen = response.answers[ACTION_QUESTION];
    if (!isChoiceAnswer(chosen)) throw new Error(`system-one returned no ${ACTION_QUESTION} choice`);

    // Unreachable against a compliant server — the label set IS the option set —
    // but a provider that invents a label must not be allowed to name a node.
    const target = built.actions[chosen.choice];
    if (!target) throw new Error(`system-one chose ${JSON.stringify(chosen.choice)}, which was not offered`);

    const base = { decided: true as const, via: SYSTEM_ONE_BRAIN, satisfied: '', remaining: '' };

    if (target.kind === 'clickTrigger') {
      return { ...base, confidence: chosen.confidence, actions: [{ kind: 'clickTrigger', nodeId: target.nodeId }] };
    }

    const decoder = built.values[target.nodeId];
    if (!decoder) return { ...base, confidence: chosen.confidence, needsValue: target.nodeId, actions: [] };

    const picked = response.answers[decoder.key];
    if (!isChoiceAnswer(picked)) throw new Error(`system-one returned no ${decoder.key} choice`);
    const value = decoder.labels[picked.choice];
    if (value === undefined) throw new Error(`system-one chose value ${JSON.stringify(picked.choice)}, not offered`);

    return {
      ...base,
      confidence: Math.min(chosen.confidence, picked.confidence),
      actions: [{ kind: 'setState', nodeId: target.nodeId, value }],
    };
  };
}

export interface GatedBrainOptions {
  fast: SystemOneBrain;
  slow: Brain;
  /** confidence at or above which the fast decision is emitted unreviewed */
  threshold: number;
}

/**
 * The gate. Note what it does NOT do: it never edits or second-guesses a
 * confident System-One decision, and it never asks the big model to ratify one.
 * It only routes.
 *
 * A System-One failure (server down, 400, bad shape) routes to the slow brain
 * too, with the reason carried in `via` so it lands in the turn log rather than
 * being swallowed — an optional accelerator must not be able to stop the agent.
 */
export function createGatedBrain({ fast, slow, threshold }: GatedBrainOptions): Brain {
  return async (input) => {
    let decision: SystemOneDecision;
    try {
      decision = await fast(input);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ...(await slow(input)), via: `${AI_SDK_BRAIN} (${SYSTEM_ONE_BRAIN} failed: ${why})` };
    }

    // Nothing afforded is a fact about the Scene, not a judgement call; the big
    // model is handed the same empty option set and would reach the same place.
    if (!decision.decided) return decision;
    if (decision.needsValue === undefined && decision.confidence >= threshold) return decision;

    const reason = decision.needsValue !== undefined ? `needs a value for ${decision.needsValue}` : 'low confidence';
    return {
      ...(await slow(input)),
      // `confidence` is kept deliberately: it is the measurement that EXPLAINS
      // the fallback, while `via` records who actually decided.
      confidence: decision.confidence,
      via: `${SYSTEM_ONE_BRAIN}->${AI_SDK_BRAIN} (${reason})`,
    };
  };
}
