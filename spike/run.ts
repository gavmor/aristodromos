// THROWAWAY SPIKE — one decision through a Mastra Agent over a Scene.
//
//   node --experimental-strip-types spike/run.ts     (or: bun spike/run.ts)
//
// Prints the structured actions the model emitted. No browser, no DOM.
import { Agent } from '@mastra/core/agent';
import { LOGIN_SCENE } from './scene.fixture';
import { createSceneTools, describeScene, type EmittedAction } from './scene-tools';
import { resolveModel } from './model';

const GOAL = 'sign in as alice@example.com';

const INSTRUCTIONS = `You drive a web page through two tools and nothing else.

You are given a semantic snapshot of the page (the Scene): a flat list of nodes,
each with a stable id. Decide from THIS snapshot alone — you have no memory of
earlier pages.

- setState(nodeId, value) puts a value into a state node.
- clickTrigger(nodeId) actuates an action node.

Only ever pass node ids that appear in the Scene.`;

async function main() {
  const { model, label, live } = await resolveModel();
  console.log(`model: ${label}${live ? '' : '  <-- NOT a live model'}`);

  const emitted: EmittedAction[] = [];
  const agent = new Agent({
    id: 'scene-policy',
    name: 'scene-policy',
    instructions: INSTRUCTIONS,
    model,
    tools: createSceneTools(LOGIN_SCENE, emitted),
  });

  const result = await agent.generate(
    `GOAL: ${GOAL}\n\nSCENE:\n${describeScene(LOGIN_SCENE)}`,
    // One observation -> one plan, which is the memoryless contract. maxSteps > 1
    // just makes the model re-emit the same plan after each tool result, and
    // re-firing clickTrigger is not something at-least-once makes safe.
    // toolChoice 'required' stops qwen3-coder answering with the call as JSON text.
    { maxSteps: 1, toolChoice: 'required' },
  );

  console.log(`\nreasoning text: ${JSON.stringify(result.text)}`);
  console.log(`\nemitted actions (${emitted.length}):`);
  for (const a of emitted) {
    console.log(
      a.kind === 'setState'
        ? `  setState(${a.nodeId}, ${JSON.stringify(a.value)})`
        : `  clickTrigger(${a.nodeId})`,
    );
  }

  const valid = emitted.every((a) => a.nodeId in LOGIN_SCENE.nodes);
  console.log(`\nall node ids valid: ${valid}`);
  if (!emitted.length || !valid) {
    throw new Error('SPIKE FAILED: no actions, or an action named an unknown node');
  }
}

main();
