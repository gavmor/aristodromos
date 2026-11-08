// AgentStrategy interface seam and action plan types.
//
// Down-edge contract: background emits an ActionPlan, and content script actuates.
// Memoryless (Markovian) decision seam: strategy decides based only on current
// observed SemanticPageMap and Goal.
import type {
  SemanticPageMap,
} from './semantic-map';

/**
 * Goal description or objective prompt for the agent.
 */
export type Goal = string | { description: string; [key: string]: unknown };

/**
 * Desired target state for an idempotent affordance (e.g. input id and value).
 */
export interface StateTarget {
  id: string;
  value: string | number | boolean;
}

/**
 * One-shot trigger action (e.g. click by trigger element id).
 */
export interface TriggerIntent {
  action: string;
  id: string;
}

/**
 * Down-edge action plan emitted from policy to content script.
 */
export interface ActionPlan {
  state_targets: StateTarget[];
  trigger_intents: TriggerIntent[];
}

/**
 * Pluggable strategy seam for computing decisions from the full semantic page map.
 */
export interface AgentStrategy {
  readonly name?: string;
  /**
   * Decide the next action plan based on the full labeled semantic page map and goal.
   */
  decide(map: SemanticPageMap, goal: Goal, signal?: AbortSignal): Promise<ActionPlan>;
}
