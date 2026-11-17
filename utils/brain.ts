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
import { generateObject, type LanguageModel, type Telemetry } from 'ai';
import { z } from 'zod';
import { buildActionSchema, isStateNode, type Plan } from './action-schema';
import { nothingAfforded, type Brain, type Decision } from './decision';
import { describeScene } from './describe-scene';
import type { ValueFiller } from './gated-brain';
import type { Scene } from './scene';

export const AI_SDK_BRAIN = 'ai-sdk';

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
  /** where to trace this call; absent, nothing is traced */
  telemetry?: Telemetry;
}): Promise<Decision> {
  const { scene, goal, model, signal, telemetry } = options;

  const built = buildActionSchema(scene);
  if (!built) return nothingAfforded(AI_SDK_BRAIN);

  const result = await generateObject({
    model,
    schema: built.schema,
    system: SYSTEM,
    prompt: `goal: ${goal}\n\nobservation:\n${describeScene(scene)}`,
    abortSignal: signal,
    telemetry: telemetry ? { integrations: telemetry, functionId: 'decide' } : { isEnabled: false },
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

/** `decide` as a `Brain`: the model (and its tracing) bound once, the Scene arrives per call. */
export const aiSdkBrain =
  (model: LanguageModel, telemetry?: Telemetry): Brain =>
  (input) =>
    decide({ ...input, model, telemetry });

/**
 * A `ValueFiller` on the same model: the target is already chosen, so the model
 * writes one string and nothing else. One small schema instead of the whole
 * action union, and no chance of it re-deciding which control to set.
 */
export const createAiSdkValueFiller =
  (model: LanguageModel, telemetry?: Telemetry): ValueFiller =>
  async ({ scene, goal, signal }, nodeId) => {
    const node = scene.nodes[nodeId];
    if (!node || !isStateNode(node)) return null;
    const scope = node.relations.container ?? node.parent;
    const where = scope !== undefined ? scene.nodes[scope]?.name : undefined;
    const field = [
      `id: ${node.id}`,
      `role: ${node.role}`,
      node.name ? `name: ${JSON.stringify(node.name)}` : null,
      where ? `inside: ${JSON.stringify(where)}` : null,
      node.placeholder ? `placeholder: ${JSON.stringify(node.placeholder)}` : null,
      `current value: ${JSON.stringify(node.value)}`,
    ].filter(Boolean);
    const result = await generateObject({
      model,
      schema: z.object({ value: z.string() }),
      system:
        'You fill in one field of a web page so the page moves toward the goal. The field is ' +
        'already chosen; answer only with the exact text it should hold, taken from the goal ' +
        'where the goal states it.',
      prompt: `goal: ${goal}\n\nfield:\n${field.join('\n')}\n\nobservation:\n${describeScene(scene)}`,
      abortSignal: signal,
      telemetry: telemetry ? { integrations: telemetry, functionId: 'fill-value' } : { isEnabled: false },
    });
    return { value: result.object.value, via: AI_SDK_BRAIN };
  };
