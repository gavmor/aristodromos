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
  /**
   * Optional System-One decider in FRONT of the Ollama brain. Absent by
   * default, which is the pre-existing behaviour exactly: one `generateObject`
   * call per observation. Set it and the cheap classifier decides first, with
   * the Ollama brain kept as the confidence-gated fallback.
   */
  systemOne?: SystemOneSettings;
}

export interface SystemOneSettings {
  /** any Jev-compatible server root; `/v1/systemone` is appended */
  baseURL: string;
  /** the model name the server expects in the request body */
  model: string;
  /** below this calibrated confidence the decision is handed to the Ollama brain */
  threshold: number;
}

export const CONFIG_KEY = 'agentConfig';
export const TURN_LOG_KEY = 'turnLog';

export const DEFAULT_CONFIG: AgentConfig = {
  goal: '',
  model: 'qwen3-coder-ud-q4kxl:latest',
  baseURL: 'http://localhost:11434/api',
};

/**
 * A starting point for the optional path, not a default: 18080 is where the
 * local AutoJev build publishes, and 0.6 is a deliberately cautious gate — the
 * fallback is cheap relative to a wrong action on a live page.
 */
export const SUGGESTED_SYSTEM_ONE: SystemOneSettings = {
  baseURL: 'http://localhost:18080',
  model: 'autojev',
  threshold: 0.6,
};
