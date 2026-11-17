// The System-One brain: a small, cheap, off-schema-impossible decider that
// answers the question the loop actually asks — "which of these legal moves is
// next?" — in one forward pass, and reports how sure it is. It is meant to sit
// in front of a slower brain behind `createGatedBrain` (gated-brain.ts), which
// hands a decision over on low confidence, or when the move is a free-text
// value that System One, picking among labels, cannot write.
//
// One tick is normally one action. The exception is a playbook (see
// system-one-questions.ts): when the chosen move lands in a scope whose every
// writable control is enumerable and which has one commit trigger, the brain
// emits all of its setStates then the commit, decoded from value questions
// that were already in the same request — no extra round trip, applied in order
// by the reconciler. The batch is all or nothing: a missing or invalid member
// answer drops back to the single action (at zero confidence when that action
// is the commit, so it is never submitted bare), and the batch's confidence is the
// minimum over the move and every member, so one unsure member sends the whole
// Scene to the slow brain instead of committing a guess.
import { nothingAfforded, type BrainInput } from './decision';
import type { ScoredDecision } from './gated-brain';
import type { PlanAction } from './action-schema';
import {
  ACTION_QUESTION,
  DONE_QUESTION,
  buildActionQuestions,
  describeState,
  type Playbook,
} from './system-one-questions';
import {
  askSystemOne,
  isChoiceAnswer,
  isNoulAnswer,
  MAX_CHOICE_CRITERIA,
  type FetchLike,
  type SystemOneResponse,
} from './system-one';

export const SYSTEM_ONE_BRAIN = 'system-one';

/**
 * `confidence` is the SERVER's calibrated number, never recomputed here (see
 * system-one.ts). On a setState it is the minimum of the action question's
 * confidence and the value question's — a sure target with an unsure value is
 * not a sure decision. On a playbook batch it is the minimum over the action
 * question and every member's value question, for the same reason.
 *
 * `needsValue` is set when the chosen move is a setState on a free-text control:
 * System One picks among labels and cannot write the string. Used alone this
 * brain idles there; behind `createGatedBrain` (gated-brain.ts) a value filler
 * or the slow brain supplies it.
 */
export type SystemOneDecision = ScoredDecision;

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
 * Every member's setState, then the commit — or undefined if any member's
 * answer is missing or names a label that was not offered. Half a playbook is
 * never returned: committing a scope with one control unset is worse than the
 * single action it would replace.
 */
function expandPlaybook(
  playbook: Playbook,
  answers: SystemOneResponse['answers'],
): { actions: PlanAction[]; confidence: number } | undefined {
  const actions: PlanAction[] = [];
  let confidence = 1;
  for (const { nodeId, decoder } of playbook.members) {
    const picked = answers[decoder.key];
    if (!isChoiceAnswer(picked)) return undefined;
    const value = decoder.labels[picked.choice];
    if (value === undefined) return undefined;
    actions.push({ kind: 'setState', nodeId, value });
    confidence = Math.min(confidence, picked.confidence);
  }
  actions.push({ kind: 'clickTrigger', nodeId: playbook.commit });
  return { actions, confidence };
}

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

    // A choice question tops out at 255 criteria. Past that, not every legal
    // action can be NAMED — and the one guarantee this brain sells is that the
    // option set is exactly the legal set. Refusing is the honest move: the gate
    // treats a System-One failure as a fallback to the big model (which has no
    // such ceiling, since its enum is a grammar), and records the reason.
    const offered = Object.keys(built.actions).length;
    if (offered > MAX_CHOICE_CRITERIA) {
      throw new Error(`scene affords ${offered} actions, over the ${MAX_CHOICE_CRITERIA}-criteria choice limit`);
    }

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
      return { decided: true, done: true, via: SYSTEM_ONE_BRAIN, confidence: done.noul, satisfied: '', remaining: '', actions: [] };
    }

    const chosen = response.answers[ACTION_QUESTION];
    if (!isChoiceAnswer(chosen)) throw new Error(`system-one returned no ${ACTION_QUESTION} choice`);

    // Unreachable against a compliant server — the label set IS the option set —
    // but a provider that invents a label must not be allowed to name a node.
    const target = built.actions[chosen.choice];
    if (!target) throw new Error(`system-one chose ${JSON.stringify(chosen.choice)}, which was not offered`);

    const base = { decided: true as const, via: SYSTEM_ONE_BRAIN, satisfied: '', remaining: '' };

    const playbook = built.playbooks.find(
      (p) => p.commit === target.nodeId || p.members.some((m) => m.nodeId === target.nodeId),
    );
    const batch = playbook && expandPlaybook(playbook, response.answers);
    if (batch) return { ...base, confidence: Math.min(chosen.confidence, batch.confidence), actions: batch.actions };
    // The commit was picked but its members could not all be decoded: a bare
    // click would submit the scope unset. Zero confidence hands it to the slow
    // brain. A picked member falls through to its own single setState instead,
    // which is safe: it is just one control per tick again.
    if (playbook && target.nodeId === playbook.commit) {
      return { ...base, confidence: 0, actions: [{ kind: 'clickTrigger', nodeId: target.nodeId }] };
    }

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
