// THROWAWAY SPIKE — model selection for the Mastra harness.
//
// Prefers a live local Ollama (qwen, tool-capable). Falls back to a canned
// tool-calling mock so the harness wiring is still exercised offline.
//
// The mock is hand-rolled rather than imported from
// `@mastra/core/test-utils/llm-mock`: that module drags msw plus net/http/
// https/zlib into the MV3 bundle, which would have polluted this spike's own
// bundle-weight measurement.
import type { LanguageModel, MastraModelConfig } from '@mastra/core/llm';

export const OLLAMA_URL = 'http://localhost:11434';

export type ModelChoice = {
  model: MastraModelConfig;
  label: string;
  live: boolean;
};

type OllamaTag = { name: string; capabilities?: string[] };

/**
 * First tool-capable qwen Ollama is serving, or undefined if unreachable.
 * Prefers a non-"thinking" model: the reasoning variants burn a minute of
 * chain-of-thought before the first tool call, which tells us nothing about
 * the harness.
 */
async function pickOllamaModel(): Promise<string | undefined> {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined);
  if (!res?.ok) return undefined;
  const { models } = (await res.json()) as { models: OllamaTag[] };
  const qwen = models.filter(
    (m) => m.capabilities?.includes('tools') && /qwen/i.test(m.name),
  );
  return (
    qwen.find((m) => !m.capabilities?.includes('thinking'))?.name ?? qwen[0]?.name
  );
}

/**
 * Canned two-call plan, so the offline path still proves the tool loop:
 * setState(email) then clickTrigger(signin).
 */
function mockModel(): LanguageModel {
  const calls = [
    {
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'setState',
      input: JSON.stringify({ nodeId: 'email', value: 'alice@example.com' }),
    },
    {
      type: 'tool-call',
      toolCallId: 'c2',
      toolName: 'clickTrigger',
      input: JSON.stringify({ nodeId: 'signin' }),
    },
  ];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  // Canned model: emit the plan on the first step, then stop, so maxSteps
  // doesn't replay it forever.
  let step = 0;
  const content = () => (step++ === 0 ? calls : []);
  const reason = () => (step === 1 ? 'tool-calls' : 'stop');
  return {
    specificationVersion: 'v2',
    provider: 'spike-mock',
    modelId: 'canned-login',
    supportedUrls: {},
    doGenerate: async () => {
      const c = content();
      return { content: c, finishReason: reason(), usage, warnings: [] };
    },
    doStream: async () => {
      const c = content();
      const finishReason = reason();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            for (const call of c) controller.enqueue(call);
            controller.enqueue({ type: 'finish', finishReason, usage });
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

export async function resolveModel(): Promise<ModelChoice> {
  const name = await pickOllamaModel();
  if (name) {
    // Mastra's built-in OpenAI-compatible router — no ollama-ai-provider needed.
    return {
      model: { id: `ollama/${name}`, url: `${OLLAMA_URL}/v1`, apiKey: 'ollama' },
      label: `live ollama ${name}`,
      live: true,
    };
  }
  return { model: mockModel(), label: 'MOCK (ollama unreachable)', live: false };
}
