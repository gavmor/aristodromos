// What the agent is for, and where its brain lives. Persisted in
// `browser.storage.local` so it survives service-worker eviction.
//
// `goal` has no default on purpose. A browser agent with a default goal is an
// agent that starts driving the first page you open; the honest resting state is
// "no goal configured", and the loop idles until someone sets one.
export interface AgentConfig {
  goal: string;
  /** Ollama tag. Tool-tuned MoE: right verb, 3B active params, fast enough to loop. */
  model: string;
  baseURL: string;
}

export const CONFIG_KEY = 'agentConfig';
export const TURN_LOG_KEY = 'turnLog';

export const DEFAULT_CONFIG: AgentConfig = {
  goal: '',
  model: 'qwen3-coder-ud-q4kxl:latest',
  baseURL: 'http://localhost:11434/api',
};
