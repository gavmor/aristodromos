// Pure policy decision core and validation.
//
// Takes observed SemanticPageMap, goal, and strategy, and returns an ActionPlan.
// - Convergence check: drops state targets whose current_value already equals the desired value.
// - ID validation: drops plan items targeting IDs not present in the observed map.
// - Risk scoring: computes a policy-side risk score via lexical matching on trigger labels.
import type {
  SemanticPageMap,
  TriggerElementAffordance,
} from './semantic-map';
import type {
  ActionPlan,
  AgentStrategy,
  Goal,
  StateTarget,
  TriggerIntent,
} from './strategy';

/**
 * Result of pure policy evaluation, including calculated risk score and plan.
 */
export interface PolicyDecision extends ActionPlan {
  /** Policy-side risk score (0.0 to 1.0) derived from trigger labels */
  riskScore: number;
  /** The sanitized, convergence-filtered ActionPlan */
  plan: ActionPlan;
}

/** High-risk / irreversible trigger keywords */
const CRITICAL_RISK_KEYWORDS = [
  'delete',
  'remove',
  'pay',
  'checkout',
  'confirm order',
  'submit order',
  'place order',
  'authorize',
  'purchase',
  'destroy',
  'terminate',
  'cancel subscription',
];

/** Medium-risk / stateful mutation trigger keywords */
const MEDIUM_RISK_KEYWORDS = [
  'submit',
  'send',
  'save',
  'update',
  'post',
  'transfer',
  'confirm',
  'apply',
];

/**
 * Policy-side lexical risk scoring helper for a single trigger label.
 * Returns a score between 0.0 (low / safe) and 1.0 (critical / high risk).
 */
export function scoreTriggerRisk(label: string): number {
  if (!label) return 0.0;
  const normalized = label.toLowerCase();

  for (const keyword of CRITICAL_RISK_KEYWORDS) {
    if (normalized.includes(keyword)) {
      return 1.0;
    }
  }

  for (const keyword of MEDIUM_RISK_KEYWORDS) {
    if (normalized.includes(keyword)) {
      return 0.5;
    }
  }

  return 0.0;
}

/**
 * Calculate the overall risk score for a plan given the observed semantic page map.
 * Returns the maximum risk score across all trigger intents in the plan.
 */
export function scorePlanRisk(plan: ActionPlan, map: SemanticPageMap): number {
  if (!plan.trigger_intents || plan.trigger_intents.length === 0) {
    return 0.0;
  }

  const triggerMap = new Map<string, TriggerElementAffordance>();
  for (const trigger of map.trigger_elements) {
    triggerMap.set(trigger.id, trigger);
  }

  let maxRisk = 0.0;
  for (const intent of plan.trigger_intents) {
    const trigger = triggerMap.get(intent.id);
    const label = trigger ? trigger.label : '';
    const score = scoreTriggerRisk(label);
    if (score > maxRisk) {
      maxRisk = score;
    }
  }

  return maxRisk;
}

/**
 * Validate that every id in the plan exists in the current map.
 * Separates valid items from invalid / hallucinated ids.
 */
export function validatePlanIds(
  plan: ActionPlan,
  map: SemanticPageMap,
): {
  valid: boolean;
  invalidStateIds: string[];
  invalidTriggerIds: string[];
  plan: ActionPlan;
} {
  const validStateIds = new Set(map.state_targets.map((s) => s.id));
  const validTriggerIds = new Set(map.trigger_elements.map((t) => t.id));

  const validTargets: StateTarget[] = [];
  const invalidStateIds: string[] = [];
  for (const target of plan.state_targets || []) {
    if (validStateIds.has(target.id)) {
      validTargets.push(target);
    } else {
      invalidStateIds.push(target.id);
    }
  }

  const validTriggers: TriggerIntent[] = [];
  const invalidTriggerIds: string[] = [];
  for (const intent of plan.trigger_intents || []) {
    if (validTriggerIds.has(intent.id)) {
      validTriggers.push(intent);
    } else {
      invalidTriggerIds.push(intent.id);
    }
  }

  const valid = invalidStateIds.length === 0 && invalidTriggerIds.length === 0;

  return {
    valid,
    invalidStateIds,
    invalidTriggerIds,
    plan: {
      state_targets: validTargets,
      trigger_intents: validTriggers,
    },
  };
}

/**
 * Check whether a target value is equivalent to the affordance's current value.
 */
function isValueConverged(
  currentValue: string | number | boolean,
  targetValue: string | number | boolean,
): boolean {
  if (currentValue === targetValue) {
    return true;
  }
  return String(currentValue) === String(targetValue);
}

/**
 * Drop state targets whose current_value already equals the desired value.
 * This is the convergence check that ensures idempotency.
 */
export function filterConvergedTargets(
  targets: StateTarget[],
  map: SemanticPageMap,
): StateTarget[] {
  const currentMap = new Map<string, string | number | boolean>();
  for (const affordance of map.state_targets) {
    currentMap.set(affordance.id, affordance.current_value);
  }

  return targets.filter((target) => {
    if (!currentMap.has(target.id)) {
      return false;
    }
    const curr = currentMap.get(target.id)!;
    return !isValueConverged(curr, target.value);
  });
}

/**
 * Pure policy decision function:
 * 1. Invokes the strategy with the full map and goal.
 * 2. Validates that all IDs exist in the map (drops unknown/hallucinated IDs).
 * 3. Filters converged state targets (drops values already satisfied on the page).
 * 4. Computes policy risk score on surviving trigger intents.
 */
export async function computePlan(
  map: SemanticPageMap,
  goal: Goal,
  strategy: AgentStrategy,
  signal?: AbortSignal,
): Promise<PolicyDecision> {
  const rawPlan = await strategy.decide(map, goal, signal);

  // 1. Validate IDs against the current map
  const { plan: validatedPlan } = validatePlanIds(rawPlan, map);

  // 2. Drop state targets whose current value already matches desired value
  const unconvergedTargets = filterConvergedTargets(validatedPlan.state_targets, map);

  const finalPlan: ActionPlan = {
    state_targets: unconvergedTargets,
    trigger_intents: validatedPlan.trigger_intents,
  };

  // 3. Score policy risk
  const riskScore = scorePlanRisk(finalPlan, map);

  return {
    state_targets: finalPlan.state_targets,
    trigger_intents: finalPlan.trigger_intents,
    riskScore,
    plan: finalPlan,
  };
}
