// spike(bg-harness): can RunMesh (iluxu) be the aristodromos background-worker brain?
//
// THROWAWAY. Happy path only. Takes a Scene, registers setState/clickTrigger over
// its node ids, runs ONE decision against local Ollama, prints the emitted actions.
//
// Two workarounds are load-bearing here; both are the spike's actual findings:
//   1. `installRunMeshResolveShim()` — every @runmesh/* package's published
//      `exports` points at a dist/index.js that is not in the tarball.
//   2. We drive `AgentExecutor` directly instead of `Agent`/`createAgent`,
//      because `Agent` hardcodes `createOpenAI({ defaultModel })` with no
//      baseURL and so can only ever reach api.openai.com — never Ollama.
import { installRunMeshResolveShim } from './runmesh-resolve-hook.ts';
// Type-only: erased before Node sees it, so it does not defeat the shim below.
import type { RegisteredTool } from '@runmesh/tools';

installRunMeshResolveShim();

const { createOpenAI } = await import('@runmesh/core');
const { ToolRegistry, tool } = await import('@runmesh/tools');
const { AgentExecutor } = await import('@runmesh/agent');
const { z } = await import('zod');
const { LOGIN_SCENE } = await import('./scene-fixture.ts');

const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
const GOAL = 'sign in as alice@example.com';

/** What the brain decided, in order. This is the spike's actual output. */
type EmittedAction =
  | { kind: 'setState'; nodeId: string; value: string }
  | { kind: 'clickTrigger'; nodeId: string };

const emitted: EmittedAction[] = [];

// --- Scene -> prompt -------------------------------------------------------
// The content script already did perception; the brain only ever sees this.
function describeScene(scene: typeof LOGIN_SCENE): string {
  const lines = Object.values(scene.nodes).map((node) => {
    const base = `- id="${node.id}" role=${node.role} name=${JSON.stringify(node.name ?? '')}`;
    if (node.category === 'state') {
      return `${base} category=state control=${node.control} value=${JSON.stringify(node.value)}`;
    }
    if (node.category === 'action') {
      return `${base} category=action action=${node.action}`;
    }
    return `${base} category=${node.category}`;
  });
  return `Page: ${scene.title} <${scene.url}>\nNodes:\n${lines.join('\n')}`;
}

// --- Tools: 1:1 onto Scene nodes -------------------------------------------
const setState = tool({
  name: 'setState',
  description:
    'Set the value of a state node (a text input). Use for typing into fields.',
  schema: z.object({
    nodeId: z.string().describe('id of a category=state node from the Scene'),
    value: z.string().describe('the value to set'),
  }),
  handler: ({ nodeId, value }) => {
    const node = LOGIN_SCENE.nodes[nodeId];
    if (!node) return { ok: false, error: `no such node: ${nodeId}` };
    if (node.category !== 'state') {
      return { ok: false, error: `node ${nodeId} is ${node.category}, not state` };
    }
    emitted.push({ kind: 'setState', nodeId, value });
    return { ok: true, nodeId, value };
  },
});

const clickTrigger = tool({
  name: 'clickTrigger',
  description: 'Click an action node (a button). Use to submit or cancel.',
  schema: z.object({
    nodeId: z.string().describe('id of a category=action node from the Scene'),
  }),
  handler: ({ nodeId }) => {
    const node = LOGIN_SCENE.nodes[nodeId];
    if (!node) return { ok: false, error: `no such node: ${nodeId}` };
    if (node.category !== 'action') {
      return { ok: false, error: `node ${nodeId} is ${node.category}, not action` };
    }
    emitted.push({ kind: 'clickTrigger', nodeId });
    return { ok: true, nodeId };
  },
});

// --- Workaround 3: flatten RunMesh's $ref-wrapped tool schemas --------------
// RunMesh's toOpenAITool() ships zod-to-json-schema's default output verbatim:
//   parameters: { $ref: "#/definitions/X", definitions: { X: {...} } }
// OpenAI's function-calling contract wants a FLAT object schema. Local engines
// render the indirection opaquely, so the model never sees the real property
// names and guesses — it emits {"id": ...} instead of {"nodeId": ...}, which
// then fails RunMesh's own zod validation and THROWS, killing the whole run.
// See spike/probe-schema-shape.ts for the controlled before/after.
type OpenAIToolDef = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

function inlineParameters(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const ref = parameters.$ref;
  const definitions = parameters.definitions as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (typeof ref !== 'string' || !definitions) return parameters;
  return definitions[ref.replace('#/definitions/', '')] ?? parameters;
}

function withInlinedSchema<T extends { toOpenAITool(): OpenAIToolDef }>(
  registered: T,
): T {
  const original = registered.toOpenAITool.bind(registered);
  return {
    ...registered,
    toOpenAITool: () => {
      const def = original();
      return {
        ...def,
        function: {
          ...def.function,
          parameters: inlineParameters(def.function.parameters),
        },
      };
    },
  };
}

const tools = new ToolRegistry();
// Workaround 4: `ToolRegistry.register(tool: RegisteredTool)` defaults its
// generics to <unknown, unknown>, and `handler` puts TInput in a contravariant
// position — so NOTHING `tool()` returns is assignable to what `register()`
// accepts. RunMesh's own advertised workflow does not typecheck under `strict`;
// `register` would have to be generic. Every consumer must cast.
tools.register(withInlinedSchema(setState) as unknown as RegisteredTool);
tools.register(withInlinedSchema(clickTrigger) as unknown as RegisteredTool);

// --- Pick a tool-capable qwen from the live Ollama --------------------------
async function pickOllamaModel(): Promise<string> {
  const res = await fetch('http://localhost:11434/api/tags');
  if (!res.ok) throw new Error(`ollama /api/tags -> HTTP ${res.status}`);
  const { models } = (await res.json()) as {
    models: { name: string; capabilities?: string[] }[];
  };
  const toolCapable = models.filter((m) => m.capabilities?.includes('tools'));
  const qwen = toolCapable.find((m) => /qwen/i.test(m.name));
  const chosen = qwen ?? toolCapable[0];
  if (!chosen) throw new Error('no tool-capable model installed in Ollama');
  return chosen.name;
}

/** Force the weights resident so the cold load isn't inside the decision. */
async function warmUp(model: string): Promise<void> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'hi', stream: false }),
  });
  if (!res.ok) throw new Error(`ollama warmup -> HTTP ${res.status}`);
  await res.json();
}

// --- One decision ----------------------------------------------------------
const model = await pickOllamaModel();
console.log(`[spike] ollama model: ${model}`);
console.log(`[spike] goal: ${GOAL}`);

console.log('[spike] warming model...');
const warmStart = Date.now();
await warmUp(model);
console.log(`[spike] warm in ${((Date.now() - warmStart) / 1000).toFixed(1)}s\n`);

const client = createOpenAI({
  apiKey: 'ollama', // Ollama ignores it; the OpenAI SDK requires it to be set
  baseURL: OLLAMA_BASE_URL,
  defaultModel: model,
  timeout: 300_000, // RunMesh defaults to 30s — too tight for local inference
});

const executor = new AgentExecutor({
  name: 'aristodromos-bg',
  model,
  client,
  tools,
  maxToolRounds: 4,
  systemPrompt:
    'You drive a web page through tools. You are given a Scene: a list of nodes ' +
    'with stable ids. Achieve the goal by calling tools that reference those ids ' +
    'EXACTLY. Never invent a node id. Fill required fields before submitting.',
});

const result = await executor
  .run(`${describeScene(LOGIN_SCENE)}\n\nGoal: ${GOAL}`)
  .catch((error: unknown) => {
    console.error(
      '[spike] executor.run() threw. RunMesh validates tool args with zod and\n' +
        '[spike] lets the ZodError escape: ONE malformed tool call aborts the\n' +
        '[spike] whole run — no feedback to the model, no repair loop.',
    );
    throw error;
  });

// --- Print what the brain emitted -------------------------------------------
if (process.env.SPIKE_DUMP_REQUEST) {
  const first = result.steps.find((s) => s.type === 'model');
  console.log('[spike] --- request RunMesh sent ---');
  console.log(JSON.stringify(first && 'request' in first ? first.request : null, null, 2));
  console.log('[spike] --- end request ---');
}

console.log('[spike] emitted actions:');
if (emitted.length === 0) {
  console.log('  (none — model returned no tool calls)');
}
for (const [i, action] of emitted.entries()) {
  const arg =
    action.kind === 'setState'
      ? `${action.nodeId}, ${JSON.stringify(action.value)}`
      : action.nodeId;
  console.log(`  ${i + 1}. ${action.kind}(${arg})`);
}

const toolSteps = result.steps.filter((s) => s.type === 'tool');
console.log(
  `\n[spike] ${result.steps.length} steps (${toolSteps.length} tool calls)`,
);
console.log(
  `[spike] final: ${JSON.stringify(result.response.choices[0]?.message?.content ?? '')}`,
);

const allValid = emitted.every((a) => a.nodeId in LOGIN_SCENE.nodes);
console.log(
  `[spike] all emitted node ids valid: ${allValid && emitted.length > 0}`,
);
