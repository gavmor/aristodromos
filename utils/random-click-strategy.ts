// RandomClickStrategy: deterministic, no-LLM policy strategy for testing and loop verification.
//
// Implements AgentStrategy by picking one trigger element and optionally populating
// one state target. Memoryless and browser-free: pure logic over SemanticPageMap.
import type {
  SemanticPageMap,
  StateTargetAffordance,
} from './semantic-map';
import type {
  ActionPlan,
  AgentStrategy,
  Goal,
  StateTarget,
  TriggerIntent,
} from './strategy';

export type RngFunction = () => number;

export interface RandomClickStrategyOptions {
  /**
   * Seeded RNG function returning a float in [0, 1), or a numeric seed for mulberry32.
   * If omitted, defaults to a deterministic pseudo-random generator (mulberry32 seeded with 0)
   * so Math.random is never invoked.
   */
  rng?: RngFunction | number;

  /**
   * If true, also selects a state target (if any exist) and populates it with a placeholder value.
   * Defaults to false.
   */
  fillStateTarget?: boolean;

  /**
   * Value used when populating a state target (when fillStateTarget is true).
   * Defaults to 'placeholder'.
   */
  placeholderValue?:
    | string
    | number
    | boolean
    | ((target: StateTargetAffordance) => string | number | boolean);
}

/**
 * Deterministic 32-bit PRNG (Mulberry32).
 * Returns a generator function producing floats in [0, 1).
 */
export function createMulberry32(seed: number): RngFunction {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pure helper to select an item index from an array using an RNG function.
 */
function pickIndex(rng: RngFunction, length: number): number {
  if (length <= 0) return 0;
  const raw = rng();
  const clamped = Math.max(0, Math.min(0.9999999999999999, Number.isFinite(raw) ? raw : 0));
  return Math.floor(clamped * length);
}

export class RandomClickStrategy implements AgentStrategy {
  readonly name = 'RandomClickStrategy';

  private readonly rng: RngFunction;
  private readonly fillStateTarget: boolean;
  private readonly placeholderValue:
    | string
    | number
    | boolean
    | ((target: StateTargetAffordance) => string | number | boolean);

  constructor(optionsOrRng?: RandomClickStrategyOptions | RngFunction | number) {
    if (typeof optionsOrRng === 'function') {
      this.rng = optionsOrRng;
      this.fillStateTarget = false;
      this.placeholderValue = 'placeholder';
    } else if (typeof optionsOrRng === 'number') {
      this.rng = createMulberry32(optionsOrRng);
      this.fillStateTarget = false;
      this.placeholderValue = 'placeholder';
    } else {
      const opts = optionsOrRng ?? {};
      if (typeof opts.rng === 'function') {
        this.rng = opts.rng;
      } else if (typeof opts.rng === 'number') {
        this.rng = createMulberry32(opts.rng);
      } else {
        this.rng = createMulberry32(0);
      }
      this.fillStateTarget = opts.fillStateTarget ?? false;
      this.placeholderValue = opts.placeholderValue ?? 'placeholder';
    }
  }

  /**
   * Decide next action plan from observed SemanticPageMap.
   *
   * Pure and memoryless: picks one trigger from trigger_elements, and if
   * fillStateTarget is enabled, fills one state target with placeholder.
   * Returns an empty plan if no triggers are present.
   */
  async decide(map: SemanticPageMap, _goal: Goal, signal?: AbortSignal): Promise<ActionPlan> {
    signal?.throwIfAborted?.();

    const triggers = map.trigger_elements ?? [];
    if (triggers.length === 0) {
      return {
        state_targets: [],
        trigger_intents: [],
      };
    }

    const triggerIdx = pickIndex(this.rng, triggers.length);
    const chosenTrigger = triggers[triggerIdx];

    const trigger_intents: TriggerIntent[] = [
      {
        action: 'click',
        id: chosenTrigger.id,
      },
    ];

    const state_targets: StateTarget[] = [];
    if (this.fillStateTarget && map.state_targets && map.state_targets.length > 0) {
      const stateIdx = pickIndex(this.rng, map.state_targets.length);
      const chosenState = map.state_targets[stateIdx];
      const value =
        typeof this.placeholderValue === 'function'
          ? this.placeholderValue(chosenState)
          : this.placeholderValue;

      state_targets.push({
        id: chosenState.id,
        value,
      });
    }

    return {
      state_targets,
      trigger_intents,
    };
  }
}

/**
 * Factory helper for creating a RandomClickStrategy.
 */
export function createRandomClickStrategy(
  optionsOrRng?: RandomClickStrategyOptions | RngFunction | number,
): RandomClickStrategy {
  return new RandomClickStrategy(optionsOrRng);
}
