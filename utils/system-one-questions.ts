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
//
// Playbooks. One action per tick makes a scope holding K enumerable controls
// and a commit trigger cost K+1 page round trips, although every value it needs
// is ALREADY asked in this one request. `buildPlaybooks` finds such scopes from
// structure alone (scope, category, control kind, reachability — never from
// names), so the brain can emit the whole scope as one ordered batch. It is
// pure Scene -> structure: each member carries its own instructions, labels and
// decoder, so a transport that asks one question per call can reuse it as is.
//
// No extra "batch or single?" question is asked: `next_action` already names
// every member and the commit, so a pick that lands inside a playbook IS the
// judgement that this scope is what comes next. A second choice would be one
// more thing the classifier could get wrong, for no information the first
// does not carry; and since setState is convergent, members that already hold
// their value are no-ops in the batch.
import { isActionNode, isReachable, isStateNode } from './action-schema';
import { describeScene } from './brain';
import type { ActionNode, NodeId, Scene, SceneNode, StateNode } from './scene';
import { MAX_CHOICE_CRITERIA } from './system-one';
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
  /** scopes whose members and commit the brain may emit as one batch */
  playbooks: Playbook[];
}

/** One control of a playbook: its own value question and how to decode it. */
export interface PlaybookMember {
  nodeId: NodeId;
  question: Extract<SystemOneQuestion, { type: 'choice' }>;
  decoder: ValueDecoder;
}

/** K enumerable controls sharing one scope, then the single trigger that commits them. */
export interface Playbook {
  scope: NodeId;
  members: PlaybookMember[];
  commit: NodeId;
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

/** A node's scope: its declared container, else its outline parent. */
const scopeOf = (node: SceneNode): NodeId | undefined => node.relations.container ?? node.parent;

/** Every scope enclosing a node, nearest first. */
function scopeChain(scene: Scene, node: SceneNode): NodeId[] {
  const chain: NodeId[] = [];
  for (let key = scopeOf(node); key !== undefined && !chain.includes(key); ) {
    chain.push(key);
    const enclosing = scene.nodes[key];
    key = enclosing && scopeOf(enclosing);
  }
  return chain;
}

/**
 * The value question for one enumerable control. A playbook member is asked
 * outright, with its current value as grounding, since the batch sets it
 * whether or not it was the move picked; `scope`, when the Scene has it, names
 * where the control sits so same-named controls in different scopes differ.
 */
function valueQuestion(
  node: StateNode,
  labels: Record<string, string | boolean>,
  member?: { scope?: SceneNode },
): PlaybookMember['question'] {
  const where = member?.scope ? ` in ${named(member.scope)}` : '';
  const instructions = member
    ? `What should ${named(node)}${where} hold (currently ${JSON.stringify(node.value)})? Keep it if it is already right.`
    : `If ${named(node)} is the control to set, what should its value become?`;
  return {
    type: 'choice',
    instructions,
    criteria: Object.fromEntries(Object.keys(labels).map((l) => [l, `Set ${named(node)}${where} to ${l}.`])),
  };
}

/** The trigger that commits a scope: its one submit, else its one trigger; anything else is ambiguous. */
function commitOf(triggers: ActionNode[]): ActionNode | undefined {
  const submits = triggers.filter((t) => t.action === 'submit');
  const candidates = submits.length > 0 ? submits : triggers;
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Scopes the brain may settle in one batch. A scope qualifies when, among its
 * reachable nodes (so disabled, modal-inert, hidden and stalled ones never
 * count):
 *   · every writable state node is enumerable and askable in one choice, and
 *     there are at least two of them;
 *   · exactly one trigger commits it (see `commitOf`);
 *   · no state control nests it inside, or inside it, another scope with controls.
 * Anything else — a free-text field, two commit candidates, nesting — is
 * ambiguous about what one batch should be, so no playbook is offered and the
 * brain stays on one action per tick.
 */
export function buildPlaybooks(scene: Scene): Playbook[] {
  const reachable = Object.values(scene.nodes).filter(isReachable);
  const interactive = reachable.filter(
    (n): n is StateNode | ActionNode => isActionNode(n) || (isStateNode(n) && !n.readOnly),
  );
  const chains = new Map(interactive.map((n) => [n, scopeChain(scene, n)]));

  const byScope = new Map<NodeId, (StateNode | ActionNode)[]>();
  for (const [node, chain] of chains) {
    if (chain.length === 0) continue;
    byScope.set(chain[0], [...(byScope.get(chain[0]) ?? []), node]);
  }

  // A state control whose scope sits inside another scope holding controls
  // makes both nested: which one a batch should settle is ambiguous, so
  // neither does. A nested scope of triggers only (a list of links) sets
  // nothing, so it leaves the outer scope's batch unambiguous.
  const nested = new Set(
    [...chains].flatMap(([node, chain]) =>
      isStateNode(node) && chain.slice(1).some((k) => byScope.get(k)?.some(isStateNode)) ? chain : [],
    ),
  );

  const playbooks: Playbook[] = [];
  for (const [scope, nodes] of byScope) {
    if (nested.has(scope)) continue;
    const commit = commitOf(nodes.filter(isActionNode));
    const states = nodes.filter(isStateNode);
    const members = states.flatMap((node) => {
      const labels = enumerableLabels(node);
      if (!labels || Object.keys(labels).length > MAX_CHOICE_CRITERIA) return [];
      const question = valueQuestion(node, labels, { scope: scene.nodes[scope] });
      return [{ nodeId: node.id, question, decoder: { key: valueQuestionKey(node.id), labels } }];
    });
    if (!commit || members.length < 2 || members.length !== states.length) continue;
    playbooks.push({ scope, members, commit: commit.id });
  }
  return playbooks;
}

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
  const playbooks = buildPlaybooks(scene);
  const members = new Map(playbooks.flatMap((p) => p.members.map((m) => [m.nodeId, m])));

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
    const member = members.get(node.id);
    const key = valueQuestionKey(node.id);
    values[node.id] = member?.decoder ?? { key, labels };
    questions[key] = member?.question ?? valueQuestion(node, labels);
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

  return { questions, actions, values, playbooks };
}

/** The `state` blob: the same Scene serialization the AI SDK brain reads, plus the goal. */
export function describeState(scene: Scene, goal: string): string {
  return `goal: ${goal}\n\nobservation:\n${describeScene(scene)}`;
}
