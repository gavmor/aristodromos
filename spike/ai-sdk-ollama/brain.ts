// SPIKE — the bg-worker "brain" on Vercel AI SDK (`ai` v7) + Ollama.
//
// This module is deliberately the WHOLE harness: Scene -> prompt -> tool-call
// loop -> emitted actions. No browser, no actuation, no memory. It is pure:
// give it a Scene and a goal, get back a list of actions for the content script.
//
// Two load-bearing ideas:
//   1. Tools are built FROM the Scene, so the node-id argument is a zod enum of
//      the ids actually present. A hallucinated id is a schema violation, not a
//      runtime surprise — grounding is enforced by the harness, not the model.
//   2. `execute` only RECORDS. The brain emits intent; the content script
//      actuates. That is what makes the loop safe to retry (at-least-once).
import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { ActionNode, Scene, StateNode } from '../../utils/scene';

/** What the brain emits. Mirrors the two content-script capabilities 1:1. */
export type EmittedAction =
  | { kind: 'setState'; nodeId: string; value: string }
  | { kind: 'clickTrigger'; nodeId: string };

export interface Decision {
  actions: EmittedAction[];
  /** final assistant text, if the model said anything after tool-calling */
  text: string;
  /** how many generation steps the tool loop consumed */
  steps: number;
}

const isState = (n: Scene['nodes'][string]): n is StateNode =>
  n.category === 'state';
const isAction = (n: Scene['nodes'][string]): n is ActionNode =>
  n.category === 'action';

/** zod `enum` needs a non-empty tuple; keep the widening in one place. */
const asTuple = (ids: string[]): [string, ...string[]] => {
  if (ids.length === 0) throw new Error('Scene exposes no nodes of this kind');
  return ids as [string, ...string[]];
};

/**
 * Flattens the Scene into the smallest text a model needs to pick a node.
 * Reports disabled/invisible rather than hiding it — same fidelity rule the
 * Scene model itself follows.
 */
export function describeScene(scene: Scene): string {
  const lines: string[] = [
    `page: ${scene.title} <${scene.url}>`,
    'controls you may set (category=state):',
  ];
  for (const node of Object.values(scene.nodes)) {
    if (!isState(node)) continue;
    const flags = [
      node.required ? 'required' : null,
      node.perception.disabled ? 'DISABLED' : null,
      node.perception.visible ? null : 'NOT-VISIBLE',
    ].filter(Boolean);
    lines.push(
      `  - id=${node.id} role=${node.role} name=${JSON.stringify(node.name ?? '')}` +
        ` control=${node.control} value=${JSON.stringify(node.value)}` +
        (flags.length ? ` [${flags.join(',')}]` : ''),
    );
  }
  lines.push('triggers you may click (category=action):');
  for (const node of Object.values(scene.nodes)) {
    if (!isAction(node)) continue;
    const flags = [
      node.perception.disabled ? 'DISABLED' : null,
      node.perception.visible ? null : 'NOT-VISIBLE',
    ].filter(Boolean);
    lines.push(
      `  - id=${node.id} role=${node.role} name=${JSON.stringify(node.name ?? '')}` +
        ` action=${node.action}` +
        (flags.length ? ` [${flags.join(',')}]` : ''),
    );
  }
  return lines.join('\n');
}

const SYSTEM = [
  'You drive a web page through two tools and nothing else.',
  'You are MEMORYLESS: decide only from the observation in this message.',
  'Call setState for every field the goal requires, then call clickTrigger ONCE',
  'on the trigger that commits the goal. Only use the ids listed in the',
  'observation. When you have called the committing trigger, stop and reply',
  'with one short sentence describing what you did.',
].join(' ');

/**
 * Run ONE memoryless decision over a Scene.
 *
 * Tools are constructed per-call because their schemas are Scene-derived; that
 * is the whole trick, and it costs ~15 lines.
 */
export async function decide(options: {
  scene: Scene;
  goal: string;
  model: LanguageModel;
  maxSteps?: number;
}): Promise<Decision> {
  const { scene, goal, model, maxSteps = 6 } = options;

  const stateIds = Object.values(scene.nodes).filter(isState).map((n) => n.id);
  const actionIds = Object.values(scene.nodes).filter(isAction).map((n) => n.id);

  const actions: EmittedAction[] = [];

  const tools = {
    setState: tool({
      description:
        'Set the value of a state node (a text field, checkbox, select). ' +
        'Convergent: re-applying the same value is a no-op.',
      inputSchema: z.object({
        nodeId: z.enum(asTuple(stateIds)).describe('Scene node id to set'),
        value: z.string().describe('the value to converge the control onto'),
      }),
      execute: async ({ nodeId, value }) => {
        actions.push({ kind: 'setState', nodeId, value });
        return `ok: ${nodeId} now ${JSON.stringify(value)}`;
      },
    }),
    clickTrigger: tool({
      description:
        'Actuate an action node (button, link, submit). Discrete effect — ' +
        'call it once, only when the state is already correct.',
      inputSchema: z.object({
        nodeId: z.enum(asTuple(actionIds)).describe('Scene node id to click'),
      }),
      execute: async ({ nodeId }) => {
        actions.push({ kind: 'clickTrigger', nodeId });
        return `ok: clicked ${nodeId}`;
      },
    }),
  };

  const result = await generateText({
    model,
    system: SYSTEM,
    prompt: `goal: ${goal}\n\nobservation:\n${describeScene(scene)}`,
    tools,
    // The card's open question: does the v7 tool loop map cleanly? It does —
    // `stopWhen` is the whole loop controller.
    stopWhen: [stepCountIs(maxSteps)],
  });

  return { actions, text: result.text, steps: result.steps.length };
}
