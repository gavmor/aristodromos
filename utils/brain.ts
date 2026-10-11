// The background worker's brain: Scene + goal -> Plan.
//
// Carried over from the `spike/ai-sdk-ollama` bake-off winner (Vercel AI SDK +
// Ollama), with one deliberate change: the spike used per-call TOOLS, and this
// uses a per-call structured OUTPUT schema.
//
// Why the change. The spike measured the tool path at 4/6 structured calls on
// the fast local model — the other 2 printed the call as prose in the assistant
// message, because tool-call extraction happens in Ollama's chat template, after
// decoding. `generateObject` instead sends the schema as Ollama's `format`,
// which compiles to GBNF and constrains the SAMPLER. There is no "model chose
// not to call a tool" failure mode left: the only token sequences it can emit
// are instances of the schema.
//
// Everything else the spike established holds: pure function of (Scene, goal),
// memoryless, and it EMITS intent rather than performing it — the content script
// still owns actuation, which is what keeps the loop safe to retry.
import { generateObject, type LanguageModel } from 'ai';
import { buildActionSchema, isScriptHref, type Plan, type PlanAction } from './action-schema';
import type { ContentNode, NodeId, Scene, SceneNode } from './scene';

/**
 * The loop's view of one decision. `actions` is empty only in named cases:
 * `done` (the brain judged the goal met on this Scene), `!decided` (nothing on
 * the page is legal to act on), and System One's `needsValue` hand-over.
 */
export interface Decision {
  /** false when the Scene affords no legal action at all */
  decided: boolean;
  /** the brain judged the goal met on this Scene; `actions` is empty */
  done?: boolean;
  satisfied: string;
  remaining: string;
  actions: PlanAction[];
  /** which brain actually produced this, for the evidence log */
  via?: string;
  /** calibrated confidence, when the deciding brain reports one */
  confidence?: number;
}

/**
 * The swappable decision seam. Both brains satisfy it, so the loop never learns
 * which one it is holding: the AI SDK one below, and the System-One one in
 * `system-one-brain.ts`.
 */
export interface BrainInput {
  scene: Scene;
  goal: string;
  signal?: AbortSignal;
}

export type Brain = (input: BrainInput) => Promise<Decision>;

export const AI_SDK_BRAIN = 'ai-sdk';

/** "The Scene affords nothing" — a real state, reported rather than papered over. */
export const nothingAfforded = (via: string): Decision => ({
  decided: false,
  via,
  satisfied: '',
  remaining: '',
  actions: [],
});

function flags(node: SceneNode): string {
  const set = [
    node.perception.disabled ? 'disabled' : null,
    node.perception.inertByModal ? 'behind modal' : null,
  ].filter(Boolean);
  return set.length ? ` [${set.join(', ')}]` : '';
}

/**
 * Page text is the model's only view of prose (a story passage, an error
 * message), so it goes in in reading order under one overall budget, about
 * 1 500 tokens. No single block may take more than TEXT_PER_BLOCK of it: one
 * wall of text (a long article, a comment thread) must not crowd out the rest.
 */
const PAGE_TEXT_BUDGET = 6000;
const TEXT_PER_BLOCK = 1500;

/**
 * Where a link goes, so the model can tell "next chapter" from a link off the
 * page entirely. Long addresses (tracking parameters, data: URLs) are cut: the
 * start says where, the rest only costs tokens.
 */
const HREF_MAX = 100;
const destination = (href: string | undefined): string => {
  if (!href || isScriptHref(href)) return '';
  return ` <${href.length > HREF_MAX ? `${href.slice(0, HREF_MAX)}…` : href}>`;
};

const quoted = (text: string | undefined): string => (text ? ` ${JSON.stringify(text)}` : '');

/** Unnamed, these only wrap: their children read at their level. */
const WRAPPER_ROLES = new Set(['document', 'rowgroup']);
/** A table with one row is still a table. */
const TABULAR_ROLES = new Set(['table', 'grid']);

/**
 * The Scene as the model reads it: an indented outline in reading order, so a
 * value sits beside its label, a choice under the passage it answers, an
 * embedded frame where its iframe is. Only lines the schema can name carry an
 * `[id]`. Unreachable nodes are still DESCRIBED — "Submit exists but is
 * disabled" is the signal to go fill the fields first — they just carry no id.
 */
export function describeScene(scene: Scene): string {
  const nodes = Object.values(scene.nodes);
  const built = buildActionSchema(scene);
  const nameable = new Set([...(built?.stateIds ?? []), ...(built?.triggerIds ?? [])]);

  // The outline: children by parent, in sibling order (ties keep insertion order).
  const childrenOf = new Map<NodeId | undefined, SceneNode[]>();
  for (const node of nodes) {
    const key = node.parent !== undefined && scene.nodes[node.parent] ? node.parent : undefined;
    const siblings = childrenOf.get(key) ?? [];
    siblings.push(node);
    childrenOf.set(key, siblings);
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.order - b.order);
  const kids = (id: NodeId | undefined): SceneNode[] => childrenOf.get(id) ?? [];
  // What the page does not render is left out, with everything under it: a
  // hidden control is not reachable either, so it would only be a ghost to click.
  const shown = (node: SceneNode): boolean => node.perception.visible;

  // The text budget goes to what is on screen first, then the rest in reading
  // order; the outline itself stays in reading order either way.
  const inReadingOrder: SceneNode[] = [];
  const walk = (parent: NodeId | undefined): void => {
    for (const node of kids(parent)) {
      if (!shown(node)) continue;
      inReadingOrder.push(node);
      walk(node.id);
    }
  };
  walk(undefined);
  const textOf = new Map<NodeId, string>();
  let used = 0;
  let omitted = 0;
  // Prose, and the bare text an unnamed structure node reads out (a list item).
  const fullTextOf = (node: SceneNode): string | undefined =>
    node.category === 'content' || node.category === 'structure' ? node.text?.trim() || undefined : undefined;
  const prose = inReadingOrder
    .filter((node) => fullTextOf(node) !== undefined)
    .toSorted((a, b) => Number(b.perception.inViewport) - Number(a.perception.inViewport));
  for (const node of prose) {
    const room = Math.min(PAGE_TEXT_BUDGET - used, TEXT_PER_BLOCK);
    if (room <= 0) {
      omitted += 1;
      continue;
    }
    const full = fullTextOf(node) ?? '';
    const text = full.length > room ? `${full.slice(0, room)}…` : full;
    used += text.length;
    textOf.set(node.id, text);
  }

  /** One node's own line, or undefined when it is only a wrapper for its children. */
  const lineFor = (node: SceneNode): string | undefined => {
    const id = nameable.has(node.id) ? `[${node.id}] ` : '';
    switch (node.category) {
      case 'state': {
        const options = node.options ? ` options=${JSON.stringify(node.options.map((o) => o.value))}` : '';
        const required = node.required ? ' required' : '';
        return `${id}(${node.role})${quoted(node.name)} = ${JSON.stringify(node.value)}${options}${required}${flags(node)}`;
      }
      case 'action': {
        const state = [
          node.expanded === undefined ? null : node.expanded ? 'expanded' : 'collapsed',
          node.pressed === undefined ? null : node.pressed ? 'pressed' : 'not pressed',
        ].filter(Boolean);
        return `${id}(${node.role})${quoted(node.name)}${destination(node.href)}${state.length ? ` (${state.join(', ')})` : ''}${flags(node)}`;
      }
      case 'content': {
        const text = textOf.get(node.id);
        const role = node.level ? `${node.role} ${node.level}` : node.role;
        if (text !== undefined) return `(${role}) ${JSON.stringify(text)}`;
        return node.role === 'img' && node.name ? `(img)${quoted(node.name)}` : undefined;
      }
      case 'structure': {
        if (node.frameSrc !== undefined) return `(iframe)${quoted(node.name)} <${node.frameSrc}>`;
        const text = textOf.get(node.id);
        if (text !== undefined) return `(${node.role})${quoted(node.name)} ${JSON.stringify(text)}`;
        if (!node.name && WRAPPER_ROLES.has(node.role)) return undefined;
        if (!node.name && kids(node.id).length <= 1 && !TABULAR_ROLES.has(node.role)) return undefined;
        return `(${node.role})${quoted(node.name)}`;
      }
    }
  };

  /** A row of plain cells reads as one line: `(row) Atmosphere: | 100%`. */
  const rowLine = (node: SceneNode): string | undefined => {
    if (node.role !== 'row') return undefined;
    const cells = kids(node.id);
    if (cells.length === 0 || cells.some((cell) => kids(cell.id).length > 0 || nameable.has(cell.id))) return undefined;
    return `(row) ${cells.map((cell) => cell.name ?? ('text' in cell ? cell.text : '')).join(' | ')}`;
  };

  const outline: string[] = [];
  const render = (parent: NodeId | undefined, depth: number): void => {
    for (const node of kids(parent)) {
      if (!shown(node)) continue;
      const indent = '  '.repeat(depth);
      const row = rowLine(node);
      if (row !== undefined) {
        outline.push(indent + row);
        continue;
      }
      const line = lineFor(node);
      if (line === undefined) {
        render(node.id, depth);
        continue;
      }
      outline.push(indent + line);
      render(node.id, depth + 1);
    }
  };
  render(undefined, 0);
  if (omitted) outline.push(`(${omitted} more text blocks omitted)`);

  const lines = [`page: ${scene.title} <${scene.url}>`];
  const frames = Object.entries(scene.frames ?? {});
  if (frames.length > 1) {
    lines.push('frames (node ids start with their frame):');
    for (const [frameId, frame] of frames) lines.push(`  - f${frameId}: ${frame.title} <${frame.url}>`);
  }
  return [...lines, 'outline:', ...outline].join('\n');
}

const SYSTEM = [
  'You drive a web page toward a goal. Read the observation, then answer in the',
  'schema, field by field.',
  '',
  'The observation is the page as an indented outline, in reading order: what a',
  'line sits under is its context (the row a value is in, the passage a choice',
  'follows). Lines that begin with [id] are the controls and triggers you can',
  'act on, by that id; every other line is there to be read.',
  '',
  'satisfied: read the CURRENT page and say which parts of the goal it already',
  'meets. A control that already holds the value the goal wants is DONE — you set',
  'it on an earlier turn. You have no memory; the page is your memory.',
  '',
  'Then answer in ONE of two ways.',
  '',
  'To act, give remaining, then actions:',
  '  remaining: the goal minus satisfied.',
  '  actions: at least one step toward "remaining". Never re-set a control that',
  '  is already correct. When every field is correct, click the trigger that',
  '  commits the goal. If that trigger is not offered to you, it is disabled; set',
  '  the fields it depends on and it will be offered on the next observation.',
  '  Where the goal is pursued by navigating (links, menu items, story choices),',
  '  click the one that best advances it.',
  '',
  'To finish, give done: true — only when the page itself shows the goal fully',
  'met. Having no obvious next step is not done: pick the best available step.',
].join('\n');

/**
 * One memoryless decision over one Scene.
 *
 * The schema is rebuilt per call because it is derived from THIS Scene. That is
 * the whole trick and it costs one function call.
 */
export async function decide(options: {
  scene: Scene;
  goal: string;
  model: LanguageModel;
  signal?: AbortSignal;
}): Promise<Decision> {
  const { scene, goal, model, signal } = options;

  const built = buildActionSchema(scene);
  if (!built) return nothingAfforded(AI_SDK_BRAIN);

  const result = await generateObject({
    model,
    schema: built.schema,
    system: SYSTEM,
    prompt: `goal: ${goal}\n\nobservation:\n${describeScene(scene)}`,
    abortSignal: signal,
  });

  const plan = result.object as Plan;
  if ('done' in plan) {
    return { decided: true, done: true, via: AI_SDK_BRAIN, satisfied: plan.satisfied, remaining: '', actions: [] };
  }

  // Belt and braces: the grammar already guarantees these ids, so a mismatch
  // here would mean the Scene moved under us, not that the model hallucinated.
  const legal = new Set([...built.stateIds, ...built.triggerIds]);
  const actions = plan.actions.filter((a) => legal.has(a.nodeId));
  if (actions.length === 0) {
    throw new Error(`plan named no node this scene affords: ${JSON.stringify(plan.actions)}`);
  }

  return { decided: true, via: AI_SDK_BRAIN, satisfied: plan.satisfied, remaining: plan.remaining, actions };
}

/** `decide` as a `Brain`: the model is bound once, the Scene arrives per call. */
export const aiSdkBrain =
  (model: LanguageModel): Brain =>
  (input) =>
    decide({ ...input, model });
