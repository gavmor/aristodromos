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
import { buildActionSchema, isActionNode, isStateNode, type Plan, type PlanAction } from './action-schema';
import type { Scene } from './scene';

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

function flags(node: { perception: { disabled: boolean; visible: boolean; inertByModal: boolean } }): string {
  const set = [
    node.perception.disabled ? 'DISABLED' : null,
    node.perception.visible ? null : 'NOT-VISIBLE',
    node.perception.inertByModal ? 'BEHIND-MODAL' : null,
  ].filter(Boolean);
  return set.length ? ` [${set.join(',')}]` : '';
}

/**
 * Page text is the model's only view of prose (a story passage, an error
 * message), so each block goes in whole; one overall budget bounds the prompt.
 * About 1 500 tokens.
 */
const PAGE_TEXT_BUDGET = 6000;

/**
 * Flatten the Scene into the smallest text sufficient to choose a node.
 * Unreachable nodes are still DESCRIBED — "Submit exists but is disabled" is the
 * signal that tells the model to go fill the fields first — even though the
 * schema will not let it act on them.
 */
export function describeScene(scene: Scene): string {
  const lines = [`page: ${scene.title} <${scene.url}>`];
  const nodes = Object.values(scene.nodes);

  lines.push('controls (setState):');
  for (const node of nodes) {
    if (!isStateNode(node)) continue;
    const extra = [
      `control=${node.control}`,
      `value=${JSON.stringify(node.value)}`,
      node.options ? `options=${JSON.stringify(node.options.map((o) => o.value))}` : null,
      node.required ? 'required' : null,
    ].filter(Boolean);
    lines.push(`  - id=${node.id} name=${JSON.stringify(node.name ?? '')} ${extra.join(' ')}${flags(node)}`);
  }

  lines.push('triggers (clickTrigger):');
  for (const node of nodes) {
    if (!isActionNode(node)) continue;
    lines.push(
      `  - id=${node.id} name=${JSON.stringify(node.name ?? '')} action=${node.action}${flags(node)}`,
    );
  }

  const readable: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const node of nodes) {
    if (node.category !== 'content' || node.text.trim() === '') continue;
    const room = PAGE_TEXT_BUDGET - used;
    if (room <= 0) {
      omitted += 1;
      continue;
    }
    const text = node.text.length > room ? `${node.text.slice(0, room)}…` : node.text;
    used += text.length;
    readable.push(`  - ${node.role}: ${JSON.stringify(text)}`);
  }
  if (omitted) readable.push(`  (${omitted} more text blocks omitted)`);
  if (readable.length) lines.push('page text:', ...readable);

  return lines.join('\n');
}

const SYSTEM = [
  'You drive a web page toward a goal. Read the observation, then answer in the',
  'schema, field by field.',
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
