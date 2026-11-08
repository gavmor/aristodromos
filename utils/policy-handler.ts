// Pure background policy handler and loop.
//
// Maintains the current SemanticPageMap by applying streamed patches, calls the
// pure policy core (computePlan) with the configured AgentStrategy on each perception,
// and sends the resulting ActionPlan down to the content script.
//
// Settled design constraints:
// - Memoryless / Markovian: decision is derived only from current observed map and goal.
// - At-least-once semantics: no acks, no effect ledger, no watermark, no dedup, no epochs.
// - No confirmation gate or human-in-the-loop.
// - DOM-free: strictly operates on semantic map representations.
import type { Operation } from 'fast-json-patch';
import {
  applySemanticPatch,
  normalizeSemanticPageMap,
  type SemanticPageMap,
} from './semantic-map';
import {
  computePlan,
  type PolicyDecision,
} from './policy';
import type {
  ActionPlan,
  AgentStrategy,
  Goal,
} from './strategy';
import {
  RandomClickStrategy,
  type RandomClickStrategyOptions,
  type RngFunction,
} from './random-click-strategy';
import {
  LLMStrategy,
  type LLMStrategyOptions,
} from './llm-strategy';

export interface StrategyFactoryOptions {
  strategy?: 'random' | 'llm' | string;
  type?: 'random' | 'llm' | string;
  model?: string;
  baseURL?: string;
  rng?: RngFunction | number;
  fillStateTarget?: boolean;
  placeholderValue?: RandomClickStrategyOptions['placeholderValue'];
  fetch?: typeof fetch;
}

/**
 * Instantiate an AgentStrategy based on name/config.
 * Defaults to LLMStrategy, with RandomClickStrategy available for test runs.
 */
export function createConfiguredStrategy(
  config?: StrategyFactoryOptions | string | AgentStrategy,
): AgentStrategy {
  if (!config) {
    return new LLMStrategy();
  }
  if (typeof config === 'object' && 'decide' in config) {
    return config as AgentStrategy;
  }

  const kind = typeof config === 'string' ? config : (config.strategy ?? config.type ?? 'llm');
  if (kind === 'random') {
    const opts = typeof config === 'object' ? config : {};
    return new RandomClickStrategy({
      rng: opts.rng,
      fillStateTarget: opts.fillStateTarget,
      placeholderValue: opts.placeholderValue,
    });
  }

  const opts = typeof config === 'object' ? config : {};
  return new LLMStrategy({
    model: opts.model,
    baseURL: opts.baseURL,
    fetch: opts.fetch,
  });
}

export interface BackgroundPolicyHandlerDeps {
  /** Configured strategy to evaluate on each perception */
  strategy: AgentStrategy;
  /** Objective or goal for the policy core */
  goal?: Goal;
  /** Callback to send the resulting ActionPlan down to the content script */
  send: (plan: ActionPlan) => void | Promise<void> | unknown;
  /** Optional initial semantic page map */
  initialMap?: SemanticPageMap;
  /** Optional turn record / logging callback */
  record?: (decision: PolicyDecision, map: SemanticPageMap) => void;
  /** Optional abort signal for policy evaluation */
  signal?: AbortSignal;
}

/**
 * Pure background policy handler managing perception streams and policy dispatch.
 */
export class BackgroundPolicyHandler {
  private currentSemanticMap: SemanticPageMap;
  private currentStrategy: AgentStrategy;
  private currentGoal: Goal;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BackgroundPolicyHandlerDeps) {
    this.currentStrategy = deps.strategy;
    this.currentGoal = deps.goal ?? '';
    this.currentSemanticMap = deps.initialMap
      ? { ...deps.initialMap }
      : { state_targets: [], trigger_elements: [] };
  }

  /**
   * The currently maintained SemanticPageMap.
   */
  get currentMap(): SemanticPageMap {
    return this.currentSemanticMap;
  }

  getStrategy(): AgentStrategy {
    return this.currentStrategy;
  }

  setStrategy(strategy: AgentStrategy): void {
    this.currentStrategy = strategy;
  }

  getGoal(): Goal {
    return this.currentGoal;
  }

  setGoal(goal: Goal): void {
    this.currentGoal = goal;
  }

  /**
   * Handle an incoming snapshot (initial perception or full resend).
   * Replaces current map with normalized map and evaluates policy.
   */
  async handleSnapshot(snapshot: unknown): Promise<PolicyDecision> {
    const raw =
      snapshot && typeof snapshot === 'object' && 'map' in snapshot
        ? (snapshot as { map: unknown }).map
        : snapshot;

    this.currentSemanticMap = normalizeSemanticPageMap(raw);
    return this.evaluatePolicy();
  }

  /**
   * Handle streamed fast-json-patch operations.
   * Applies patches to the current map using pure applySemanticPatch and evaluates policy.
   */
  async handlePatch(
    patch: Operation | Operation[] | { ops: Operation[] } | { kind: 'patch'; ops: Operation[] },
  ): Promise<PolicyDecision> {
    let ops: Operation[];
    if (Array.isArray(patch)) {
      ops = patch;
    } else if (patch && typeof patch === 'object' && 'ops' in patch && Array.isArray(patch.ops)) {
      ops = patch.ops;
    } else if (patch && typeof patch === 'object' && 'op' in patch && 'path' in patch) {
      ops = [patch as Operation];
    } else {
      ops = [];
    }

    this.currentSemanticMap = applySemanticPatch(this.currentSemanticMap, ops);
    return this.evaluatePolicy();
  }

  /**
   * Ingest an arbitrary perception message (snapshot or patch), serialised in order.
   */
  ingest(message: unknown): Promise<PolicyDecision | void> {
    const next = this.queue.then(() => this.processMessage(message));
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Route message to handleSnapshot or handlePatch based on structure.
   */
  async handleMessage(message: unknown): Promise<PolicyDecision | void> {
    return this.processMessage(message);
  }

  private async processMessage(message: unknown): Promise<PolicyDecision | void> {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (Array.isArray(message)) {
      return this.handlePatch(message as Operation[]);
    }

    const obj = message as Record<string, unknown>;

    // Check for patch message
    if (obj.kind === 'patch' || (Array.isArray(obj.ops) && obj.ops.length > 0)) {
      return this.handlePatch(message as { ops: Operation[] });
    }

    // Check for single operation
    if (typeof obj.op === 'string' && typeof obj.path === 'string') {
      return this.handlePatch(message as Operation);
    }

    // Check for snapshot message
    if (
      obj.kind === 'snapshot' ||
      'map' in obj ||
      'state_targets' in obj ||
      'trigger_elements' in obj ||
      'stateTargets' in obj ||
      'triggerElements' in obj
    ) {
      return this.handleSnapshot(message);
    }
  }

  private async evaluatePolicy(): Promise<PolicyDecision> {
    const decision = await computePlan(
      this.currentSemanticMap,
      this.currentGoal,
      this.currentStrategy,
      this.deps.signal,
    );

    await this.deps.send(decision.plan);
    this.deps.record?.(decision, this.currentSemanticMap);
    return decision;
  }
}

export function createBackgroundHandler(
  deps: BackgroundPolicyHandlerDeps,
): BackgroundPolicyHandler {
  return new BackgroundPolicyHandler(deps);
}

// Aliases matching domain terminology
export { BackgroundPolicyHandler as PolicyLoop, BackgroundPolicyHandler as PolicyHandler };
export type {
  BackgroundPolicyHandlerDeps as PolicyLoopDeps,
  BackgroundPolicyHandlerDeps as PolicyHandlerDeps,
};
