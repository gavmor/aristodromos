import { describe, expect, it, vi } from 'vitest';
import type { Operation } from 'fast-json-patch';
import {
  BackgroundPolicyHandler,
  createBackgroundHandler,
  createConfiguredStrategy,
} from '../utils/policy-handler';
import { RandomClickStrategy } from '../utils/random-click-strategy';
import { LLMStrategy } from '../utils/llm-strategy';
import type { ActionPlan, AgentStrategy } from '../utils/strategy';
import type { SemanticPageMap, WireSemanticPageMap } from '../utils/semantic-map';
import { fakeBrowser } from '@webext-core/fake-browser';

describe('BackgroundPolicyHandler integration with RandomClickStrategy', () => {
  it('drives the background handler with a sequence of patches and RandomClickStrategy, asserting that plans are sent', async () => {
    const sentPlans: ActionPlan[] = [];
    const strategy = new RandomClickStrategy({
      rng: () => 0.1,
      fillStateTarget: true,
      placeholderValue: 'test-value',
    });

    const handler = createBackgroundHandler({
      strategy,
      goal: 'Complete registration form',
      send: (plan) => {
        sentPlans.push(plan);
      },
    });

    // 1. Initial perception via snapshot
    const initialMap: WireSemanticPageMap = {
      document_id: 'doc_1',
      title: 'Registration',
      state_targets: [
        { id: 'input_name', type: 'text_input', label: 'Full Name', current_value: '' },
      ],
      trigger_elements: [
        { id: 'btn_register', type: 'button_click', label: 'Register' },
      ],
    };

    await handler.handleSnapshot(initialMap);
    expect(sentPlans).toHaveLength(1);
    expect(sentPlans[0].trigger_intents).toEqual([{ action: 'click', id: 'btn_register' }]);
    expect(sentPlans[0].state_targets).toEqual([{ id: 'input_name', value: 'test-value' }]);

    // 2. Stream patch 1: Content script streams patch adding email field
    const patch1: Operation[] = [
      {
        op: 'add',
        path: '/state_targets/1',
        value: { id: 'input_email', type: 'text_input', label: 'Email', current_value: '' },
      },
    ];

    await handler.handlePatch(patch1);
    expect(sentPlans).toHaveLength(2);
    expect(handler.currentMap.state_targets).toHaveLength(2);
    expect(sentPlans[1].trigger_intents).toEqual([{ action: 'click', id: 'btn_register' }]);

    // 3. Stream patch 2: Content script streams patch adding a cancel button
    const patch2: Operation[] = [
      {
        op: 'add',
        path: '/trigger_elements/1',
        value: { id: 'btn_cancel', type: 'button_click', label: 'Cancel' },
      },
    ];

    await handler.handlePatch(patch2);
    expect(sentPlans).toHaveLength(3);
    expect(handler.currentMap.trigger_elements).toHaveLength(2);

    // 4. Stream patch 3 wrapped in { ops } format
    const patch3 = {
      kind: 'patch' as const,
      ops: [
        { op: 'replace' as const, path: '/state_targets/0/current_value', value: 'Jane Doe' },
      ],
    };

    await handler.ingest(patch3);
    expect(sentPlans).toHaveLength(4);
    expect(handler.currentMap.state_targets[0].current_value).toBe('Jane Doe');
  });

  it('preserves Markovian property: decisions depend purely on current map without history watermark', async () => {
    const sentPlans: ActionPlan[] = [];
    const strategy = new RandomClickStrategy({
      rng: () => 0.0,
      fillStateTarget: false,
    });

    const handler = new BackgroundPolicyHandler({
      strategy,
      goal: 'Explore',
      send: (plan) => {
        sentPlans.push(plan);
      },
    });

    // Ingest perception
    await handler.ingest({
      state_targets: [],
      trigger_elements: [{ id: 'btn_1', type: 'button_click', label: 'Step 1' }],
    });
    expect(sentPlans).toHaveLength(1);
    expect(sentPlans[0].trigger_intents[0].id).toBe('btn_1');

    // Ingest next perception without internal ack or epoch memory
    await handler.ingest([
      { op: 'replace', path: '/trigger_elements/0/id', value: 'btn_2' },
      { op: 'replace', path: '/trigger_elements/0/label', value: 'Step 2' },
    ]);
    expect(sentPlans).toHaveLength(2);
    expect(sentPlans[1].trigger_intents[0].id).toBe('btn_2');
  });
});

describe('Convergence and idempotency via re-perception', () => {
  it('once the map shows the goal satisfied, the next cycle emits an empty or no-op plan', async () => {
    const sentPlans: ActionPlan[] = [];

    // Custom strategy that always attempts to set email and name to desired values
    const formFillStrategy: AgentStrategy = {
      name: 'FormFillStrategy',
      async decide(): Promise<ActionPlan> {
        return {
          state_targets: [
            { id: 'input_email', value: 'alice@example.com' },
            { id: 'input_name', value: 'Alice' },
          ],
          trigger_intents: [],
        };
      },
    };

    const handler = new BackgroundPolicyHandler({
      strategy: formFillStrategy,
      goal: 'Fill user profile',
      send: (plan) => {
        sentPlans.push(plan);
      },
      initialMap: {
        state_targets: [
          { id: 'input_email', type: 'text_input', label: 'Email', current_value: '' },
          { id: 'input_name', type: 'text_input', label: 'Name', current_value: '' },
        ],
        trigger_elements: [],
      },
    });

    // Cycle 1: initial perception -> neither target satisfied
    await handler.handleSnapshot(handler.currentMap);
    expect(sentPlans).toHaveLength(1);
    expect(sentPlans[0].state_targets).toEqual([
      { id: 'input_email', value: 'alice@example.com' },
      { id: 'input_name', value: 'Alice' },
    ]);

    // Cycle 2: content script actuated email; streamed patch updates current_value
    await handler.handlePatch([
      { op: 'replace', path: '/state_targets/0/current_value', value: 'alice@example.com' },
    ]);
    expect(sentPlans).toHaveLength(2);
    // email is converged and filtered out; only input_name remains unconverged
    expect(sentPlans[1].state_targets).toEqual([{ id: 'input_name', value: 'Alice' }]);

    // Cycle 3: content script actuated name; streamed patch updates current_value
    await handler.handlePatch([
      { op: 'replace', path: '/state_targets/1/current_value', value: 'Alice' },
    ]);
    expect(sentPlans).toHaveLength(3);
    // Now both targets are satisfied: the cycle emits an empty plan!
    expect(sentPlans[2].state_targets).toEqual([]);
    expect(sentPlans[2].trigger_intents).toEqual([]);

    // Cycle 4: Re-perception without DOM changes emits empty plan again (idempotent)
    await handler.handleSnapshot(handler.currentMap);
    expect(sentPlans).toHaveLength(4);
    expect(sentPlans[3].state_targets).toEqual([]);
    expect(sentPlans[3].trigger_intents).toEqual([]);
  });
});

describe('Audit: labels intact to strategy', () => {
  it('asserts labels are present in the map handed to the strategy', async () => {
    let observedMapInStrategy: SemanticPageMap | undefined;

    const inspectingStrategy: AgentStrategy = {
      name: 'InspectingStrategy',
      async decide(map): Promise<ActionPlan> {
        observedMapInStrategy = map;
        return {
          state_targets: [],
          trigger_intents: [],
        };
      },
    };

    const handler = new BackgroundPolicyHandler({
      strategy: inspectingStrategy,
      goal: 'Audit labels',
      send: () => {},
    });

    // 1. Initial map with explicit labels and wire element names
    const wireMap: WireSemanticPageMap = {
      state_targets: [
        { id: 'st_1', type: 'text_input', label: 'Primary Email', current_value: '' },
        { id: 'st_2', type: 'text_input', name: 'Billing Address', current_value: '' }, // element name
      ],
      trigger_elements: [
        { id: 'tr_1', type: 'button_click', label: 'Pay Now ($10.00)' },
        { id: 'tr_2', type: 'button_click', name: 'Cancel Order' }, // element name
      ],
    };

    await handler.handleSnapshot(wireMap);

    expect(observedMapInStrategy).toBeDefined();
    // Labels provided explicitly
    expect(observedMapInStrategy!.state_targets[0].label).toBe('Primary Email');
    expect(observedMapInStrategy!.trigger_elements[0].label).toBe('Pay Now ($10.00)');
    // Element names mapped to labels without being stripped
    expect(observedMapInStrategy!.state_targets[1].label).toBe('Billing Address');
    expect(observedMapInStrategy!.trigger_elements[1].label).toBe('Cancel Order');

    // 2. Stream a patch adding a new trigger element with name
    await handler.handlePatch([
      {
        op: 'add',
        path: '/trigger_elements/2',
        value: { id: 'tr_3', type: 'button_click', name: 'Delete Account' },
      },
    ]);

    expect(observedMapInStrategy!.trigger_elements).toHaveLength(3);
    expect(observedMapInStrategy!.trigger_elements[2].label).toBe('Delete Account');
  });
});

describe('Configurable strategy selection and runtime updates', () => {
  it('allows strategy configuration and dynamic updates', () => {
    const randomStrategy = createConfiguredStrategy('random');
    expect(randomStrategy).toBeInstanceOf(RandomClickStrategy);

    const randomStrategyWithOpts = createConfiguredStrategy({
      strategy: 'random',
      rng: 42,
      fillStateTarget: true,
    });
    expect(randomStrategyWithOpts).toBeInstanceOf(RandomClickStrategy);

    const llmStrategy = createConfiguredStrategy({
      strategy: 'llm',
      model: 'qwen-custom',
      baseURL: 'http://localhost:11434',
    });
    expect(llmStrategy).toBeInstanceOf(LLMStrategy);

    const handler = new BackgroundPolicyHandler({
      strategy: randomStrategy,
      goal: 'Initial Goal',
      send: () => {},
    });

    expect(handler.getStrategy()).toBe(randomStrategy);
    expect(handler.getGoal()).toBe('Initial Goal');

    handler.setStrategy(llmStrategy);
    handler.setGoal('Updated Goal');

    expect(handler.getStrategy()).toBe(llmStrategy);
    expect(handler.getGoal()).toBe('Updated Goal');
  });

  it('integrates with fakeBrowser storage and configuration changes', async () => {
    await fakeBrowser.storage.local.set({
      agentConfig: {
        goal: 'Search products',
        strategy: 'random',
      },
    });

    const stored = await fakeBrowser.storage.local.get('agentConfig');
    const config = stored.agentConfig as { goal: string; strategy: string };
    expect(config.strategy).toBe('random');

    const strategy = createConfiguredStrategy(config.strategy);
    expect(strategy).toBeInstanceOf(RandomClickStrategy);

    const sent: ActionPlan[] = [];
    const handler = new BackgroundPolicyHandler({
      strategy,
      goal: config.goal,
      send: (plan) => {
        sent.push(plan);
      },
    });

    await handler.ingest({
      state_targets: [],
      trigger_elements: [{ id: 'search_button', type: 'button_click', label: 'Search' }],
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].trigger_intents[0].id).toBe('search_button');
  });
});
