// THROWAWAY SPIKE — can dexto (truffle-ai) be the aristodromos background-worker brain?
//
// Memoryless single decision: Scene in -> structured action plan out. No browser here;
// the tools only record what the content script would be told to do.
//
// Run: bun spike/dexto/harness.ts
import {
  DextoAgent,
  InMemoryDextoStores,
  createLogger,
  defineTool,
} from '@dexto/core';
import { z } from 'zod';
import type { Scene } from '../../utils/scene';
import { loginScene } from './scene-fixture';

const OLLAMA_BASE = 'http://localhost:11434';
// Qwen3-Coder-30B-A3B (Q5_K_XL) via Ollama.
// Two other local Qwens were rejected on evidence, not taste:
//   qwen3.5:latest        — a *thinking* model; 110s of reasoning before any tool
//                           call, blowing dexto's turn timeout.
//   qwen3-coder Q4_K_M    — emits the tool call as plain TEXT once dexto's
//                           always-on built-in `tool_output_read` tool is in the
//                           request (+407 prompt tokens). Same payload minus that
//                           one tool parses fine. See SPIKE-FINDINGS.md.
const MODEL = 'hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:UD-Q5_K_XL';
const GOAL = 'sign in as alice@example.com';

/** What the harness would hand back down to the content script. */
type PlannedAction =
  | { kind: 'setState'; nodeId: string; value: string }
  | { kind: 'clickTrigger'; nodeId: string };

const plan: PlannedAction[] = [];

/** The Scene, flattened into something a 9B local model can read. */
function renderScene(scene: Scene): string {
  const lines = Object.values(scene.nodes).map((n) => {
    const base = `- ${n.id} [${n.category}/${n.role}] "${n.name ?? ''}"`;
    if (n.category === 'state') {
      return `${base} control=${n.control} value=${JSON.stringify(n.value)}`;
    }
    if (n.category === 'action') return `${base} action=${n.action}`;
    return base;
  });
  return `PAGE ${scene.title} <${scene.url}>\nNODES:\n${lines.join('\n')}`;
}

const stateNodeIds = Object.values(loginScene.nodes)
  .filter((n) => n.category === 'state')
  .map((n) => n.id);
const actionNodeIds = Object.values(loginScene.nodes)
  .filter((n) => n.category === 'action')
  .map((n) => n.id);

const setState = defineTool({
  id: 'setState',
  description:
    'Converge a state node to a value. nodeId must be a state node id from the Scene.',
  inputSchema: z.object({
    nodeId: z.enum(stateNodeIds as [string, ...string[]]),
    value: z.string(),
  }),
  execute: ({ nodeId, value }) => {
    plan.push({ kind: 'setState', nodeId, value });
    return { ok: true, nodeId, value };
  },
});

const clickTrigger = defineTool({
  id: 'clickTrigger',
  description:
    'Fire an action node. nodeId must be an action node id from the Scene. Call this last.',
  inputSchema: z.object({
    nodeId: z.enum(actionNodeIds as [string, ...string[]]),
  }),
  execute: ({ nodeId }) => {
    plan.push({ kind: 'clickTrigger', nodeId });
    return { ok: true, nodeId };
  },
});

async function ollamaReachable(): Promise<boolean> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`).catch(() => null);
  return res?.ok === true;
}

async function main(): Promise<void> {
  if (!(await ollamaReachable())) {
    throw new Error(
      `Ollama unreachable at ${OLLAMA_BASE} — spike needs a live model or a mock wired in.`,
    );
  }

  const agentId = 'aristodromos-bg-spike';
  const agent = new DextoAgent({
    agentId,
    logger: createLogger({
      config: { level: 'error', transports: [{ type: 'silent' }] },
      agentId,
    }),
    stores: new InMemoryDextoStores(),
    systemPrompt:
      'You drive a web page through tools only. You are given a Scene: a flat list of ' +
      'semantic page nodes. Decide from the Scene alone — you have no memory of past turns. ' +
      'Call setState for every field the goal requires, then exactly one clickTrigger. ' +
      'Never invent a nodeId.',
    llm: {
      provider: 'ollama',
      model: MODEL,
      baseURL: `${OLLAMA_BASE}/v1`,
      temperature: 0,
      maxIterations: 6,
    },
    tools: [setState, clickTrigger],
  });

  await agent.start();
  const response = await agent.generate(
    `GOAL: ${GOAL}\n\n${renderScene(loginScene)}`,
    'spike-session',
  );
  await agent.stop();

  console.log('--- model:', MODEL);
  console.log('--- raw tool calls from dexto:');
  console.dir(
    response.toolCalls.map((c) => ({ tool: c.toolName, args: c.args })),
    { depth: null },
  );
  console.log('--- emitted action plan:');
  for (const a of plan) {
    console.log(
      a.kind === 'setState'
        ? `    setState(${a.nodeId}, ${JSON.stringify(a.value)})`
        : `    clickTrigger(${a.nodeId})`,
    );
  }
  console.log('--- assistant text:', JSON.stringify(response.content));
}

await main();
