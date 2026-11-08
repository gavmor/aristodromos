import { describe, expect, it, vi } from 'vitest';
import type { SemanticPageMap } from '../utils/semantic-map';
import type { ActionPlan } from '../utils/strategy';
import {
  createMulberry32,
  createRandomClickStrategy,
  RandomClickStrategy,
} from '../utils/random-click-strategy';
import { computePlan } from '../utils/policy';

describe('RandomClickStrategy', () => {
  const sampleMap: SemanticPageMap = {
    document_id: 'doc_1',
    title: 'Test Page',
    state_targets: [
      { id: 'input_name', type: 'text_input', label: 'Full Name', current_value: '' },
      { id: 'input_email', type: 'text_input', label: 'Email', current_value: 'a@b.com' },
      { id: 'chk_subscribe', type: 'checkbox', label: 'Subscribe', current_value: false },
    ],
    trigger_elements: [
      { id: 'btn_first', type: 'button_click', label: 'First' },
      { id: 'btn_second', type: 'button_click', label: 'Second' },
      { id: 'btn_third', type: 'button_click', label: 'Third' },
      { id: 'btn_submit', type: 'button_click', label: 'Submit Order' },
    ],
  };

  it('picks the expected trigger with a seeded RNG', async () => {
    // Test with deterministic injected RNG functions
    const pickFirst = new RandomClickStrategy(() => 0.0);
    const planFirst = await pickFirst.decide(sampleMap, 'Test goal');
    expect(planFirst.trigger_intents).toEqual([{ action: 'click', id: 'btn_first' }]);

    const pickSecond = new RandomClickStrategy(() => 0.26);
    const planSecond = await pickSecond.decide(sampleMap, 'Test goal');
    expect(planSecond.trigger_intents).toEqual([{ action: 'click', id: 'btn_second' }]);

    const pickThird = new RandomClickStrategy(() => 0.51);
    const planThird = await pickThird.decide(sampleMap, 'Test goal');
    expect(planThird.trigger_intents).toEqual([{ action: 'click', id: 'btn_third' }]);

    const pickLast = new RandomClickStrategy(() => 0.99);
    const planLast = await pickLast.decide(sampleMap, 'Test goal');
    expect(planLast.trigger_intents).toEqual([{ action: 'click', id: 'btn_submit' }]);
  });

  it('produces identical deterministic sequence with mulberry32 seed', async () => {
    const strategy1 = new RandomClickStrategy({ rng: 42 });
    const strategy2 = new RandomClickStrategy({ rng: 42 });

    for (let i = 0; i < 5; i++) {
      const plan1 = await strategy1.decide(sampleMap, 'Goal');
      const plan2 = await strategy2.decide(sampleMap, 'Goal');
      expect(plan1).toEqual(plan2);
    }
  });

  it('gives an empty plan when trigger_elements is empty', async () => {
    const emptyTriggersMap: SemanticPageMap = {
      state_targets: [
        { id: 'input_name', type: 'text_input', label: 'Full Name', current_value: '' },
      ],
      trigger_elements: [],
    };

    const strategy = new RandomClickStrategy({ rng: 0, fillStateTarget: true });
    const plan = await strategy.decide(emptyTriggersMap, 'Do something');

    expect(plan).toEqual({
      state_targets: [],
      trigger_intents: [],
    });
  });

  it('gives an empty plan when both triggers and state_targets are empty', async () => {
    const emptyMap: SemanticPageMap = {
      state_targets: [],
      trigger_elements: [],
    };

    const strategy = new RandomClickStrategy();
    const plan = await strategy.decide(emptyMap, 'Goal');

    expect(plan.state_targets).toHaveLength(0);
    expect(plan.trigger_intents).toHaveLength(0);
  });

  it('ensures every returned id exists in the input map', async () => {
    const strategy = new RandomClickStrategy({
      rng: createMulberry32(12345),
      fillStateTarget: true,
      placeholderValue: 'sample-value',
    });

    const validTriggerIds = new Set(sampleMap.trigger_elements.map((t) => t.id));
    const validStateIds = new Set(sampleMap.state_targets.map((s) => s.id));

    for (let i = 0; i < 30; i++) {
      const plan = await strategy.decide(sampleMap, 'Goal');

      expect(plan.trigger_intents).toHaveLength(1);
      expect(validTriggerIds.has(plan.trigger_intents[0].id)).toBe(true);

      expect(plan.state_targets).toHaveLength(1);
      expect(validStateIds.has(plan.state_targets[0].id)).toBe(true);
    }
  });

  it('conforms strictly to the ActionPlan type', async () => {
    const strategy = createRandomClickStrategy({
      rng: 99,
      fillStateTarget: true,
      placeholderValue: 'custom-text',
    });

    const plan: ActionPlan = await strategy.decide(sampleMap, 'Goal');

    expect(Array.isArray(plan.state_targets)).toBe(true);
    expect(Array.isArray(plan.trigger_intents)).toBe(true);
    expect(plan.trigger_intents).toHaveLength(1);
    expect(typeof plan.trigger_intents[0].id).toBe('string');
    expect(plan.trigger_intents[0].action).toBe('click');
    expect(plan.state_targets).toHaveLength(1);
    expect(typeof plan.state_targets[0].id).toBe('string');
    expect(plan.state_targets[0].value).toBe('custom-text');
  });

  it('does not fill state targets when fillStateTarget is false or omitted', async () => {
    const strategy = new RandomClickStrategy(42);
    const plan = await strategy.decide(sampleMap, 'Goal');

    expect(plan.state_targets).toEqual([]);
    expect(plan.trigger_intents).toHaveLength(1);
  });

  it('supports functional placeholder values when fillStateTarget is true', async () => {
    const strategy = new RandomClickStrategy({
      rng: () => 0.0,
      fillStateTarget: true,
      placeholderValue: (target) => `val_for_${target.id}`,
    });

    const plan = await strategy.decide(sampleMap, 'Goal');
    expect(plan.state_targets).toEqual([
      {
        id: 'input_name',
        value: 'val_for_input_name',
      },
    ]);
  });

  it('does not call Math.random directly inside the logic', async () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');

    const strategyWithDefault = new RandomClickStrategy();
    await strategyWithDefault.decide(sampleMap, 'Goal');

    const strategyWithNumber = new RandomClickStrategy(777);
    await strategyWithNumber.decide(sampleMap, 'Goal');

    const strategyWithOptions = new RandomClickStrategy({ fillStateTarget: true });
    await strategyWithOptions.decide(sampleMap, 'Goal');

    expect(mathRandomSpy).not.toHaveBeenCalled();
    mathRandomSpy.mockRestore();
  });

  it('is memoryless and does not retain internal history of clicked ids', async () => {
    let rngStep = 0;
    const alternatingRng = () => {
      // Alternates between 0 (first element) and 0.99 (last element)
      const val = rngStep % 2 === 0 ? 0.0 : 0.99;
      rngStep++;
      return val;
    };

    const strategy = new RandomClickStrategy({ rng: alternatingRng });

    // Step 1: picks first trigger
    const plan1 = await strategy.decide(sampleMap, 'Goal');
    expect(plan1.trigger_intents[0].id).toBe('btn_first');

    // Step 2: picks last trigger
    const plan2 = await strategy.decide(sampleMap, 'Goal');
    expect(plan2.trigger_intents[0].id).toBe('btn_submit');

    // Step 3: picks first trigger again — it does not filter it out because it is memoryless
    const plan3 = await strategy.decide(sampleMap, 'Goal');
    expect(plan3.trigger_intents[0].id).toBe('btn_first');
  });

  it('respects AbortSignal if passed', async () => {
    const strategy = new RandomClickStrategy();
    const controller = new AbortController();
    controller.abort();

    await expect(strategy.decide(sampleMap, 'Goal', controller.signal)).rejects.toThrow();
  });

  it('integrates seamlessly with computePlan in policy core', async () => {
    const strategy = new RandomClickStrategy({
      rng: () => 0.99, // Picks 'btn_submit' (label: 'Submit Order' -> risk score 1.0) and 'chk_subscribe'
      fillStateTarget: true,
      placeholderValue: 'updated-name',
    });

    const decision = await computePlan(sampleMap, 'Submit checkout', strategy);

    expect(decision.trigger_intents).toEqual([{ action: 'click', id: 'btn_submit' }]);
    expect(decision.riskScore).toBe(1.0);
    expect(decision.state_targets).toEqual([{ id: 'chk_subscribe', value: 'updated-name' }]);
  });
});
