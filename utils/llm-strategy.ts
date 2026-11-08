// LLMStrategy implementing AgentStrategy seam via local Ollama.
//
// Pure policy worker: takes observed SemanticPageMap and Goal, formats a prompt
// preserving all affordance IDs, types, labels, and current values, requests JSON
// from Ollama, and parses the response into an ActionPlan.
//
// Memoryless: sends only the current map and goal. No conversation history or
// stateful store; idempotency comes from re-perception.
import type { SemanticPageMap } from './semantic-map';
import type { ActionPlan, AgentStrategy, Goal } from './strategy';
import { validatePlanIds } from './policy';

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3-coder-ud-q4kxl:latest';

/**
 * Options for configuring LLMStrategy.
 */
export interface LLMStrategyOptions {
  /** Ollama model tag (defaults to Qwen model) */
  model?: string;
  /** Ollama server base URL (defaults to http://localhost:11434) */
  baseURL?: string;
  /** Injected fetch function for network isolation and testing */
  fetch?: typeof fetch;
}

/**
 * Options for thin Ollama fetch wrapper.
 */
export interface OllamaFetchOptions {
  baseURL?: string;
  model: string;
  prompt: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Helper to normalize Goal into a readable string description.
 */
export function formatGoal(goal: Goal): string {
  if (typeof goal === 'string') {
    return goal;
  }
  if (goal && typeof goal.description === 'string') {
    return goal.description;
  }
  return JSON.stringify(goal);
}

/**
 * Pure function: renders SemanticPageMap and Goal into a complete prompt string.
 *
 * Preserves every affordance's id, type, and label; for state targets, also includes current_value.
 */
export function buildPrompt(map: SemanticPageMap, goal: Goal): string {
  const goalDescription = formatGoal(goal);

  const stateLines =
    map.state_targets && map.state_targets.length > 0
      ? map.state_targets
          .map(
            (t) =>
              `- id: "${t.id}", type: "${t.type}", label: "${t.label}", current_value: ${JSON.stringify(t.current_value)}`,
          )
          .join('\n')
      : '(none)';

  const triggerLines =
    map.trigger_elements && map.trigger_elements.length > 0
      ? map.trigger_elements
          .map((e) => `- id: "${e.id}", type: "${e.type}", label: "${e.label}"`)
          .join('\n')
      : '(none)';

  return `You are an automated browser agent. Decide the next action plan to achieve the goal.

Goal:
${goalDescription}

Available State Targets (inputs, toggles, form fields that accept a value):
${stateLines}

Available Trigger Elements (buttons, links, clickable items):
${triggerLines}

Instructions:
Respond with a JSON object with:
- "state_targets": array of { "id": "<id>", "value": <desired_value> }
- "trigger_intents": array of { "action": "click", "id": "<id>" }
Only reference IDs that are explicitly listed in the available affordances above.
Output valid JSON format only.`;
}

/**
 * Extract JSON substring or strip markdown code fences.
 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

/**
 * Pure function: parses raw model text response into an ActionPlan.
 *
 * - Drops hallucinated IDs not present in the map.
 * - Tolerates malformed output by returning an empty plan; never throws.
 */
export function parseModelResponse(text: string, map: SemanticPageMap): ActionPlan {
  const emptyPlan: ActionPlan = { state_targets: [], trigger_intents: [] };
  if (!text || typeof text !== 'string') {
    return emptyPlan;
  }

  try {
    const jsonStr = extractJson(text);
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyPlan;
    }

    const rawTargets = Array.isArray(parsed.state_targets)
      ? parsed.state_targets
      : Array.isArray(parsed.stateTargets)
        ? parsed.stateTargets
        : [];

    const rawTriggers = Array.isArray(parsed.trigger_intents)
      ? parsed.trigger_intents
      : Array.isArray(parsed.triggerIntents)
        ? parsed.triggerIntents
        : [];

    const rawPlan: ActionPlan = {
      state_targets: rawTargets
        .filter(
          (t: unknown): t is { id: unknown; value?: unknown } =>
            Boolean(t) && typeof t === 'object' && 'id' in (t as object) && (t as { id: unknown }).id != null,
        )
        .map((t: { id: unknown; value?: unknown }) => ({
          id: String(t.id),
          value: (t.value !== undefined ? t.value : '') as string | number | boolean,
        })),
      trigger_intents: rawTriggers
        .filter(
          (i: unknown): i is { id: unknown; action?: unknown } =>
            Boolean(i) && typeof i === 'object' && 'id' in (i as object) && (i as { id: unknown }).id != null,
        )
        .map((i: { id: unknown; action?: unknown }) => ({
          id: String(i.id),
          action: typeof i.action === 'string' && i.action.trim() ? i.action : 'click',
        })),
    };

    return validatePlanIds(rawPlan, map).plan;
  } catch {
    return emptyPlan;
  }
}

/**
 * Thin fetch wrapper calling Ollama's HTTP API with format: 'json'.
 */
export async function callOllama(options: OllamaFetchOptions): Promise<string> {
  const fetchFn =
    options.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : fetch);
  const rawBaseURL = options.baseURL ?? DEFAULT_OLLAMA_BASE_URL;
  const trimmed = rawBaseURL.replace(/\/+$/, '');
  const url = trimmed.endsWith('/api/generate')
    ? trimmed
    : trimmed.endsWith('/api')
      ? `${trimmed}/generate`
      : `${trimmed}/api/generate`;

  const body = {
    model: options.model,
    prompt: options.prompt,
    format: 'json',
    stream: false,
  };

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Ollama HTTP error ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    response?: unknown;
    message?: { content?: unknown };
  };

  if (data && typeof data === 'object') {
    if (typeof data.response === 'string') {
      return data.response;
    }
    if (data.message && typeof data.message.content === 'string') {
      return data.message.content;
    }
  }

  return typeof data === 'string' ? data : JSON.stringify(data);
}

/**
 * AgentStrategy implementation using local Ollama model.
 */
export class LLMStrategy implements AgentStrategy {
  readonly name: string = 'llm-ollama';
  readonly model: string;
  readonly baseURL: string;
  private readonly fetchFn?: typeof fetch;

  constructor(options?: LLMStrategyOptions) {
    this.model = options?.model ?? DEFAULT_OLLAMA_MODEL;
    this.baseURL = options?.baseURL ?? DEFAULT_OLLAMA_BASE_URL;
    this.fetchFn = options?.fetch;
  }

  async decide(map: SemanticPageMap, goal: Goal, signal?: AbortSignal): Promise<ActionPlan> {
    try {
      const prompt = buildPrompt(map, goal);
      const text = await callOllama({
        baseURL: this.baseURL,
        model: this.model,
        prompt,
        fetch: this.fetchFn,
        signal,
      });
      return parseModelResponse(text, map);
    } catch {
      return {
        state_targets: [],
        trigger_intents: [],
      };
    }
  }
}
