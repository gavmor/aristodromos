// SPIKE RUNNER — one memoryless decision, printed.
//
//   node spike/ai-sdk-ollama/run.ts
//   OLLAMA_MODEL=qwen3-coder-ud-q4kxl:latest node spike/ai-sdk-ollama/run.ts
//   SPIKE_FORCE_MOCK=1 node spike/ai-sdk-ollama/run.ts
//
// Node 26 strips types natively, so there is no ts-node/tsx/esbuild step here.
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createOllama } from 'ollama-ai-provider-v2';
import { decide } from './brain.ts';
import { loginScene } from './scene-fixture.ts';

const OLLAMA_URL = 'http://localhost:11434';
const GOAL = 'sign in as alice@example.com';

// No @types/node in this repo and the spike does not warrant adding it; read
// the two env knobs through a narrow cast rather than pulling a dep.
const env = (key: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[key];

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Canned two-step transcript: tool calls first, then a closing text turn so the
 * loop terminates on its own instead of burning every step.
 */
function mockModel(): LanguageModel {
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
    totalTokens: 0,
  };
  return new MockLanguageModelV4({
    modelId: 'mock-canned-qwen',
    doGenerate: [
      {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'setState',
            input: JSON.stringify({
              nodeId: 'email',
              value: 'alice@example.com',
            }),
          },
          {
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'clickTrigger',
            input: JSON.stringify({ nodeId: 'signin' }),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: 'text', text: 'Filled the email and submitted.' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
}

async function main() {
  const forced = env('SPIKE_FORCE_MOCK') === '1';
  const live = !forced && (await ollamaReachable());
  const modelId = env('OLLAMA_MODEL') ?? 'qwen3.5:latest';

  let model: LanguageModel;
  if (live) {
    model = createOllama({ baseURL: `${OLLAMA_URL}/api` }).chat(modelId);
    console.log(`[spike] LIVE ollama — model ${modelId}`);
  } else {
    model = mockModel();
    console.log(
      `[spike] MOCK model (${forced ? 'forced' : 'ollama unreachable'}) — ` +
        'the printed actions below are canned, not reasoned.',
    );
  }

  const started = Date.now();
  const decision = await decide({ scene: loginScene, goal: GOAL, model });
  const elapsed = Date.now() - started;

  console.log(`\n[spike] goal: ${GOAL}`);
  console.log(`[spike] steps: ${decision.steps}  elapsed: ${elapsed}ms`);
  console.log('[spike] emitted actions:');
  if (decision.actions.length === 0) {
    console.log('  (none — the model answered without calling a tool)');
  }
  for (const a of decision.actions) {
    console.log(
      a.kind === 'setState'
        ? `  setState(${a.nodeId}, ${JSON.stringify(a.value)})`
        : `  clickTrigger(${a.nodeId})`,
    );
  }
  console.log(`[spike] final text: ${decision.text || '(empty)'}`);

  // Every emitted id must exist in the Scene. The zod enums make this true by
  // construction; assert it anyway so the spike's claim is checked, not assumed.
  // An empty action list is a FAILED decision, not a vacuous pass.
  const bad = decision.actions.filter((a) => !(a.nodeId in loginScene.nodes));
  if (decision.actions.length === 0) {
    console.log('[spike] FAIL — no structured tool call was emitted');
  } else if (bad.length > 0) {
    console.log(`[spike] UNGROUNDED ids: ${bad.map((b) => b.nodeId).join(', ')}`);
  } else {
    console.log('[spike] all emitted ids resolve to real Scene nodes ✓');
  }
}

await main();
