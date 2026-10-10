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
import type { ContentNode, Scene } from './scene';

export interface Decision extends Plan {
  /** false when the Scene affords no legal action at all */
  decided: boolean;
}

const NOTHING_AFFORDED: Decision = {
  decided: false,
  satisfied: '',
  remaining: '',
  actions: [],
};

function flags(node: { perception: { disabled: boolean; visible: boolean; inertByModal: boolean } }): string {
  const set = [
    node.perception.disabled ? 'DISABLED' : null,
    node.perception.visible ? null : 'NOT-VISIBLE',
    node.perception.inertByModal ? 'BEHIND-MODAL' : null,
  ].filter(Boolean);
  return set.length ? ` [${set.join(',')}]` : '';
}

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

  const readable = nodes
    .filter((n): n is ContentNode => n.category === 'content' && n.text.trim() !== '')
    .slice(0, 20)
    .map((n) => `  - ${n.role}: ${JSON.stringify(n.text.slice(0, 160))}`);
  if (readable.length) lines.push('page text:', ...readable);

  return lines.join('\n');
}

const SYSTEM = [
  'You drive a web page. Fill in the three fields of the schema, in order.',
  '',
  'satisfied: read the CURRENT values in the observation and say which parts of',
  'the goal they already meet. A control that already holds the value the goal',
  'wants is DONE — you set it on an earlier turn. You have no memory; the page is',
  'your memory.',
  '',
  'remaining: the goal minus satisfied. If nothing remains, say so.',
  '',
  'actions: only what "remaining" calls for. Never re-set a control that is',
  'already correct. When every field is correct, the only thing left is to click',
  'the trigger that commits the goal — do that. If the committing trigger is not',
  'offered to you, it is disabled; set the fields it depends on instead and it',
  'will be offered on the next observation. If nothing remains at all, emit an',
  'empty action list.',
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
  if (!built) return NOTHING_AFFORDED;

  const result = await generateObject({
    model,
    schema: built.schema,
    system: SYSTEM,
    prompt: `goal: ${goal}\n\nobservation:\n${describeScene(scene)}`,
    abortSignal: signal,
  });

  const object = result.object as Plan;
  // Belt and braces: the grammar already guarantees these ids, so a mismatch
  // here would mean the Scene moved under us, not that the model hallucinated.
  const legal = new Set([...built.stateIds, ...built.triggerIds]);
  const actions = (object.actions ?? []).filter((a: PlanAction) => legal.has(a.nodeId));

  return {
    decided: true,
    satisfied: object.satisfied ?? '',
    remaining: object.remaining ?? '',
    actions,
  };
}
