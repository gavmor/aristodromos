import type { Operation } from 'fast-json-patch';
import type { OperationSchema } from './types';
import type { AgentStrategy, AgentDecision } from './strategy';

/** System prompt for the Qwen agent */
export function buildSystemPrompt(): string {
  return `You are a browser automation agent that operates in a ReAct (Reasoning + Acting) loop.

Your goal is to explore the page and interact with elements to complete the user's task.

You receive observations about the current page state including interactive elements.
You output structured JSON with your reasoning and the operations to perform.

Available operations (JSON Patch format):
- { "op": "replace", "path": "/<el-key>/clicked", "value": true } — Click an element
- { "op": "replace", "path": "/<el-key>/value", "value": "text" } — Type text into a field

Rules:
1. Always reason step-by-step before acting
2. Only use paths listed in allowedPaths
3. Call the "complete" function when done: { "op": "complete", "path": "/complete", "value": "Task finished" }
4. Output valid JSON only: { "reasoning": "...", "operations": [...] }
5. Never repeat the same action twice`;
}

/** Build the user message from the current page observation */
export function buildObservationPrompt(
  schema: OperationSchema,
  newInformation: string[],
): string {
  const interactables = schema.allowedPaths
    .map((p) => `  - ${p}`)
    .join('\n');

  return `Current page state:
${newInformation.map((s) => `- ${s}`).join('\n')}

Interactive elements (use these paths):
${interactables}

Available operations: ${schema.allowedOperations.join(', ')}

Respond with JSON: { "reasoning": "...", "operations": [...] }`;
}

/** Call ollama and return the raw response text */
export async function callOllama(
  model: string,
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      format: 'json',
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`ollama error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.message?.content ?? '';
}

export const OLLAMA_MODEL = 'qwen3.6:27b';

/**
 * Strategy that uses an LLM (ollama) to decide actions on the page.
 * Wraps the existing callOllama-based logic from this module.
 */
export class LLMStrategy implements AgentStrategy {
  readonly name = 'llm-ollama';

  constructor(private model: string = OLLAMA_MODEL) {}

  async decide(
    schema: OperationSchema,
    newInformation: string[],
    abortSignal: AbortSignal,
  ): Promise<AgentDecision> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildObservationPrompt(schema, newInformation) },
    ];

    const raw = await callOllama(this.model, messages, abortSignal);
    const parsed = JSON.parse(raw);

    const operations: Operation[] = [];
    if (Array.isArray(parsed.operations)) {
      for (const op of parsed.operations) {
        if (op.path === '/complete') continue;
        operations.push(op);
      }
    }

    return {
      operations,
      reasoning: parsed.reasoning ?? '',
    };
  }
}
