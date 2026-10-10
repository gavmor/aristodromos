// Scene -> System-One questions. The probability-layer twin of action-schema.ts.
//
// `buildActionSchema` makes an illegal (verb, nodeId) pair UNREPRESENTABLE in a
// grammar. This makes it UNNAMEABLE in a choice: every legal pair gets exactly
// one option, and an illegal pair has no option at all, so no amount of
// probability mass can land on it. Same guarantee, different enforcement point —
// the sampler there, the label set here.
//
// Option labels are slugs of the target's ACCESSIBLE NAME, not opaque node ids:
// a classifier that answers from label-token probabilities needs the semantics
// in the label. `fill_email_address` carries signal; `n7` does not. The slug ->
// (verb, nodeId) map comes back out of here so the decode is exact.
//
// Two things System-One structurally cannot do, and how each is handled:
//   · generate free text — so a text field's VALUE is not asked here at all;
//     the node is still offered as an action, and the caller's fallback brain
//     synthesizes the value. Enumerable values (a select's own options, a
//     checkbox's true/false) ARE askable, so they get their own choice question
//     and stay on this side of the seam.
//   · decide that nothing is left to do — every choice question has a winner, so
//     an action question alone can never terminate the loop. A `noul` carries
//     that judgement instead, and it is the brain's only stop condition.
import { isActionNode, isReachable, isStateNode } from './action-schema';
import { describeScene } from './brain';
import type { Scene, StateNode } from './scene';
import type { SystemOneQuestion } from './system-one';

/** The question name under which the next (verb, nodeId) is asked. */
export const ACTION_QUESTION = 'next_action';
/** The question name carrying "is the goal already met?". */
export const DONE_QUESTION = 'goal_reached';
/** Per-node value questions are namespaced so they cannot collide with the two above. */
export const valueQuestionKey = (nodeId: string): string => `value_of_${nodeId}`;

/** A (verb, nodeId) pair, before any value is attached. */
export interface ActionTarget {
  kind: 'setState' | 'clickTrigger';
  nodeId: string;
}

/** How to turn a value question's winning label back into a Scene value. */
export interface ValueDecoder {
  key: string;
  labels: Record<string, string | number | boolean>;
}

export interface ActionQuestions {
  /** the `questions` map to POST */
  questions: Record<string, SystemOneQuestion>;
  /** option label -> the pair it names; the inverse of the choice criteria */
  actions: Record<string, ActionTarget>;
  /** nodeId -> value decoder, present only for nodes whose value is enumerable */
  values: Record<string, ValueDecoder>;
}

/**
 * Label tokens: lower snake case, ASCII, never empty. Collisions are resolved by
 * the caller, not here, because uniqueness is a property of the whole set.
 */
function slug(parts: string[]): string {
  const joined = parts
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return joined === '' ? 'unnamed' : joined.slice(0, 48);
}

function unique(taken: Set<string>, candidate: string): string {
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  for (let n = 2; ; n++) {
    const next = `${candidate}_${n}`;
    if (!taken.has(next)) {
      taken.add(next);
      return next;
    }
  }
}

/** The verb a human would use for this control, which is also the label's stem. */
function verbFor(node: StateNode): string {
  if (node.control === 'boolean') return 'toggle';
  if (node.control === 'option') return 'choose';
  if (node.control === 'range' || node.control === 'scroll') return 'adjust';
  return 'fill';
}

/** Enumerable = System-One can pick the value itself, so it never leaves the protocol. */
function enumerableLabels(node: StateNode): Record<string, string | boolean> | null {
  if (node.control === 'boolean') {
    return { yes: true, no: false };
  }
  if (node.control === 'option') {
    const options = (node.options ?? []).filter((o) => o.value !== '');
    if (options.length === 0) return null;
    const taken = new Set<string>();
    const labels: Record<string, string> = {};
    for (const option of options) labels[unique(taken, slug([option.label || option.value]))] = option.value;
    return labels;
  }
  return null;
}

const named = (node: { name?: string; role: string }): string => node.name?.trim() || `the ${node.role}`;

/**
 * Build the whole request body's `questions`, plus the decode tables.
 *
 * Returns null on a Scene that affords nothing — the same "no legal action" case
 * `buildActionSchema` reports, and for the same reason: a choice over an empty
 * criteria set is not a question.
 */
export function buildActionQuestions(scene: Scene): ActionQuestions | null {
  const reachable = Object.values(scene.nodes).filter(isReachable);
  const stateNodes = reachable.filter(isStateNode).filter((n) => !n.readOnly);
  const triggerNodes = reachable.filter(isActionNode);

  const criteria: Record<string, string> = {};
  const actions: Record<string, ActionTarget> = {};
  const values: Record<string, ValueDecoder> = {};
  const questions: Record<string, SystemOneQuestion> = {};
  const taken = new Set<string>();

  for (const node of stateNodes) {
    const label = unique(taken, slug([verbFor(node), named(node)]));
    const labels = enumerableLabels(node);
    criteria[label] =
      `Set ${named(node)} (${node.control} control, currently ${JSON.stringify(node.value)}` +
      `${node.required ? ', required' : ''}${node.invalid ? ', currently invalid' : ''}).`;
    actions[label] = { kind: 'setState', nodeId: node.id };

    if (!labels) continue;
    const key = valueQuestionKey(node.id);
    values[node.id] = { key, labels };
    questions[key] = {
      type: 'choice',
      instructions: `If ${named(node)} is the control to set, what should its value become?`,
      criteria: Object.fromEntries(Object.keys(labels).map((l) => [l, `Set ${named(node)} to ${l}.`])),
    };
  }

  for (const node of triggerNodes) {
    const label = unique(taken, slug(['click', named(node)]));
    criteria[label] = `Activate ${named(node)} (${node.action}${node.href ? ` to ${node.href}` : ''}).`;
    actions[label] = { kind: 'clickTrigger', nodeId: node.id };
  }

  if (Object.keys(criteria).length === 0) return null;

  questions[ACTION_QUESTION] = {
    type: 'choice',
    instructions:
      'Exactly one move is allowed next. Read the CURRENT control values first: a control that ' +
      'already holds what the goal wants is done, so do not pick it again. Pick the single move ' +
      'that brings the page closest to the goal.',
    criteria,
  };
  questions[DONE_QUESTION] = {
    type: 'noul',
    instructions:
      'Judging only from the page as it is right now, has the goal already been fully achieved, ' +
      'leaving nothing at all to do?',
  };

  return { questions, actions, values };
}

/** The `state` blob: the same Scene serialization the AI SDK brain reads, plus the goal. */
export function describeState(scene: Scene, goal: string): string {
  return `goal: ${goal}\n\nobservation:\n${describeScene(scene)}`;
}
