// THROWAWAY SPIKE — bg-worker "brain" harness feasibility probe for
// @hatchet-dev/icepick 0.1.9.
//
// Question: can icepick serve as the aristodromos background-worker decision loop,
// bundled into the WXT MV3 service worker? One decision, happy path, eyeball exit.
//
// Build + run:  pnpm spike:icepick
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { Icepick } from '@hatchet-dev/icepick';
import {
  LOGIN_SCENE,
  actionNodeIds,
  describeScene,
  stateNodeIds,
} from './scene.fixture';

const OLLAMA_BASE = 'http://localhost:11434';
const MODEL = 'qwen3-coder-ud-q4kxl:latest';
const GOAL = 'sign in as alice@example.com';
const STEP_TIMEOUT_MS = 90_000;

/** What the brain emits. Perception + actuation live in the content script. */
type EmittedAction =
  | { tool: 'setState'; nodeId: string; value: string }
  | { tool: 'clickTrigger'; nodeId: string };

const emitted: EmittedAction[] = [];

const STATE_IDS = stateNodeIds(LOGIN_SCENE);
const ACTION_IDS = actionNodeIds(LOGIN_SCENE);
const asEnum = (ids: string[]) => z.enum(ids as [string, ...string[]]);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, bomb]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// ---------------------------------------------------------------------------
// 0. Give icepick its best shot without standing up Hatchet.
//
// The Icepick constructor refuses to build without HATCHET_CLIENT_TOKEN. The SDK
// only *decodes* that JWT (it never verifies the signature) to read the engine
// addresses out of its claims, so an unsigned stub gets us past config loading
// and lets the next failure be the honest one: the actual engine connection.
// ---------------------------------------------------------------------------

function stubHatchetToken(): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'none', typ: 'JWT' });
  const payload = b64({
    sub: 'spike-tenant',
    server_url: 'http://localhost:7077',
    grpc_broadcast_address: 'localhost:7070',
  });
  return `${header}.${payload}.`;
}

// ---------------------------------------------------------------------------
// 1. Harness wiring: two tools mapped 1:1 onto Scene node ids.
// ---------------------------------------------------------------------------

function buildHarness() {
  const ollama = createOpenAI({ baseURL: `${OLLAMA_BASE}/v1`, apiKey: 'ollama' });

  // NOTE: Icepick extends the Hatchet client. This constructor already loads
  // Hatchet client config (token, engine host) — it is not a local object.
  const icepick = Icepick.init({ defaultLanguageModel: ollama(MODEL) });

  const setState = icepick.tool({
    name: 'setState',
    description:
      'Set the value of a convergent state node in the Scene (a text input, checkbox, select). Idempotent.',
    inputSchema: z.object({
      nodeId: asEnum(STATE_IDS).describe('Scene node id of the state node to set'),
      value: z.string().describe('The value to converge the node onto'),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    fn: async (input) => {
      emitted.push({ tool: 'setState', nodeId: input.nodeId, value: input.value });
      return { ok: true };
    },
  });

  const clickTrigger = icepick.tool({
    name: 'clickTrigger',
    description:
      'Actuate an action node in the Scene (a button or link). Discrete effect, not convergent.',
    inputSchema: z.object({
      nodeId: asEnum(ACTION_IDS).describe('Scene node id of the action node to fire'),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    fn: async (input) => {
      emitted.push({ tool: 'clickTrigger', nodeId: input.nodeId });
      return { ok: true };
    },
  });

  const toolbox = icepick.toolbox({ tools: [setState, clickTrigger] as const });
  return { icepick, toolbox };
}

const PROMPT = `You are the decision brain of a browser agent. Decide the next action.

GOAL: ${GOAL}

CURRENT PAGE OBSERVATION (Scene):
${describeScene(LOGIN_SCENE)}

Call exactly one tool, referencing a Scene node id verbatim.`;

// ---------------------------------------------------------------------------
// 2. Control probe: the same decision, same model, no harness. Isolates whether
//    a failure below is icepick's infrastructure or the model's competence.
// ---------------------------------------------------------------------------

async function controlProbe(): Promise<unknown> {
  const body = {
    model: MODEL,
    stream: false,
    messages: [{ role: 'user', content: PROMPT }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'setState',
          description: 'Set the value of a state node in the Scene.',
          parameters: {
            type: 'object',
            properties: {
              nodeId: { type: 'string', enum: STATE_IDS },
              value: { type: 'string' },
            },
            required: ['nodeId', 'value'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'clickTrigger',
          description: 'Actuate an action node in the Scene.',
          parameters: {
            type: 'object',
            properties: { nodeId: { type: 'string', enum: ACTION_IDS } },
            required: ['nodeId'],
          },
        },
      },
    ],
  };
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message?: { tool_calls?: unknown } };
  return data.message?.tool_calls ?? null;
}

// ---------------------------------------------------------------------------
// 3. Run ONE decision.
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== SPIKE: icepick (hatchet-dev) as bg-worker brain ===');
  console.log(`model: ${MODEL} @ ${OLLAMA_BASE}`);
  console.log(`goal:  ${GOAL}`);
  console.log(`scene node ids: state=[${STATE_IDS}] action=[${ACTION_IDS}]\n`);

  console.log('--- [A] control probe: raw Ollama tool-calling, no harness ---');
  try {
    const calls = await withTimeout(controlProbe(), STEP_TIMEOUT_MS, 'control probe');
    console.log('control tool_calls:', JSON.stringify(calls, null, 2));
  } catch (err) {
    console.log('control probe FAILED:', (err as Error).message);
  }

  console.log('\n--- [B] icepick harness: construct client + toolbox ---');
  if (!process.env.HATCHET_CLIENT_TOKEN) {
    process.env.HATCHET_CLIENT_TOKEN = stubHatchetToken();
    process.env.HATCHET_CLIENT_TLS_STRATEGY = 'none';
    console.log('(no HATCHET_CLIENT_TOKEN in env — injecting an unsigned stub token');
    console.log(' pointed at localhost:7070 so the next failure is the engine, not config)');
  }
  let toolbox: ReturnType<typeof buildHarness>['toolbox'];
  try {
    ({ toolbox } = buildHarness());
    console.log('harness constructed OK');
  } catch (err) {
    console.log('HARNESS CONSTRUCTION FAILED:', (err as Error).message);
    console.log('\nVERDICT INPUT: icepick could not even be instantiated locally.');
    return;
  }

  console.log('\n--- [C] icepick toolbox.pickAndRun: one decision ---');
  try {
    const result = await withTimeout(
      toolbox.pickAndRun({ prompt: PROMPT }),
      STEP_TIMEOUT_MS,
      'pickAndRun',
    );
    console.log('pickAndRun result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.log('pickAndRun FAILED:', (err as Error).message);
  }

  console.log('\n--- emitted actions (the deliverable of the brain) ---');
  console.log(emitted.length ? JSON.stringify(emitted, null, 2) : '(none)');
}

main()
  .catch((err) => {
    console.error('UNCAUGHT:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Hatchet keeps gRPC/axios handles open; a spike should not hang on them.
    setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
  });
