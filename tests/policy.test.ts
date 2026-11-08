import { describe, expect, it } from 'vitest';
import type { Operation } from 'fast-json-patch';
import {
  applySemanticPatch,
  normalizeSemanticPageMap,
  type SemanticPageMap,
  type WireSemanticPageMap,
} from '../utils/semantic-map';
import {
  computePlan,
  filterConvergedTargets,
  scorePlanRisk,
  scoreTriggerRisk,
  validatePlanIds,
} from '../utils/policy';
import type { ActionPlan, AgentStrategy, Goal } from '../utils/strategy';

describe('applySemanticPatch', () => {
  it('applies a fast-json-patch operation to update affordances', () => {
    const original: SemanticPageMap = {
      state_targets: [
        { id: 'email_1', type: 'text_input', label: 'Email', current_value: 'old@example.com' },
      ],
      trigger_elements: [{ id: 'submit_btn', type: 'button_click', label: 'Submit' }],
    };

    const patch: Operation[] = [
      { op: 'replace', path: '/state_targets/0/current_value', value: 'new@example.com' },
    ];

    const updated = applySemanticPatch(original, patch);

    expect(updated.state_targets[0].current_value).toBe('new@example.com');
    // Ensure pure function / immutability
    expect(original.state_targets[0].current_value).toBe('old@example.com');
    expect(updated).not.toBe(original);
  });

  it('handles add and remove operations on trigger elements', () => {
    const original: SemanticPageMap = {
      state_targets: [],
      trigger_elements: [{ id: 'btn_1', type: 'button_click', label: 'Cancel' }],
    };

    const patch: Operation[] = [
      {
        op: 'add',
        path: '/trigger_elements/1',
        value: { id: 'btn_2', type: 'button_click', label: 'Delete Account' },
      },
    ];

    const updated = applySemanticPatch(original, patch);
    expect(updated.trigger_elements).toHaveLength(2);
    expect(updated.trigger_elements[1].id).toBe('btn_2');
    expect(original.trigger_elements).toHaveLength(1);
  });

  it('handles empty patches without mutating the document', () => {
    const original: SemanticPageMap = {
      state_targets: [{ id: '1', type: 'text_input', label: 'Test', current_value: 'val' }],
      trigger_elements: [],
    };

    const updated = applySemanticPatch(original, []);
    expect(updated).toEqual(original);
  });
});

describe('normalizeSemanticPageMap', () => {
  it('normalizes wire format preserving labels and values', () => {
    const wire: WireSemanticPageMap = {
      document_id: 'doc_123',
      title: 'Checkout Form',
      state_targets: [
        {
          id: 'input_email_1',
          type: 'text_input',
          label: 'Email Address',
          current_value: 'alice@example.com',
          is_idempotent: true,
        },
      ],
      trigger_elements: [
        {
          id: 'btn_pay_1',
          type: 'button_click',
          label: 'Pay Now ($25.00)',
          is_idempotent: false,
          risk_level: 'critical',
          side_effect_hint: 'external_transaction',
        },
      ],
    };

    const normalized = normalizeSemanticPageMap(wire);

    expect(normalized.document_id).toBe('doc_123');
    expect(normalized.title).toBe('Checkout Form');
    expect(normalized.state_targets).toEqual([
      {
        id: 'input_email_1',
        type: 'text_input',
        label: 'Email Address',
        current_value: 'alice@example.com',
      },
    ]);
    expect(normalized.trigger_elements).toEqual([
      {
        id: 'btn_pay_1',
        type: 'button_click',
        label: 'Pay Now ($25.00)',
      },
    ]);
    // Verifies wire-only fields like risk_level are ignored
    expect((normalized.trigger_elements[0] as unknown as Record<string, unknown>).risk_level).toBeUndefined();
  });

  it('converts missing or null labels into empty strings without dropping them', () => {
    const wire: WireSemanticPageMap = {
      state_targets: [
        { id: 'target_without_label', type: 'text_input', current_value: 'hello' },
        { id: 'target_null_label', type: 'text_input', label: null, current_value: 'world' },
      ],
      trigger_elements: [
        { id: 'btn_no_label', type: 'button_click' },
        { id: 'btn_null_label', type: 'button_click', label: null },
      ],
    };

    const normalized = normalizeSemanticPageMap(wire);

    expect(normalized.state_targets[0].label).toBe('');
    expect(normalized.state_targets[1].label).toBe('');
    expect(normalized.trigger_elements[0].label).toBe('');
    expect(normalized.trigger_elements[1].label).toBe('');
  });

  it('handles camelCase aliases and malformed inputs gracefully', () => {
    const wire = {
      documentId: 'doc_456',
      stateTargets: [{ id: 's1', type: 'toggle', label: 'Agree', currentValue: true }],
      triggerElements: [{ id: 't1', type: 'submit', label: 'Submit' }],
    };

    const normalized = normalizeSemanticPageMap(wire);
    expect(normalized.document_id).toBe('doc_456');
    expect(normalized.state_targets[0].current_value).toBe(true);
    expect(normalized.trigger_elements[0].label).toBe('Submit');

    const empty = normalizeSemanticPageMap(null);
    expect(empty.state_targets).toEqual([]);
    expect(empty.trigger_elements).toEqual([]);
  });
});

describe('convergence filtering', () => {
  const map: SemanticPageMap = {
    state_targets: [
      { id: 'input_email', type: 'text_input', label: 'Email', current_value: 'alice@example.com' },
      { id: 'input_name', type: 'text_input', label: 'Name', current_value: 'Alice' },
      { id: 'toggle_opt_in', type: 'boolean_toggle', label: 'Opt in', current_value: false },
    ],
    trigger_elements: [],
  };

  it('drops state targets whose current_value already equals the desired value', () => {
    const targets = [
      { id: 'input_email', value: 'alice@example.com' }, // Already satisfied
      { id: 'input_name', value: 'Bob' }, // Needs update
      { id: 'toggle_opt_in', value: false }, // Already satisfied
    ];

    const filtered = filterConvergedTargets(targets, map);

    expect(filtered).toEqual([{ id: 'input_name', value: 'Bob' }]);
  });

  it('produces an empty plan when an already-satisfied goal is presented to computePlan', async () => {
    const strategy: AgentStrategy = {
      name: 'test-strategy',
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

    const decision = await computePlan(map, 'Fill user details', strategy);

    expect(decision.state_targets).toEqual([]);
    expect(decision.trigger_intents).toEqual([]);
    expect(decision.plan.state_targets).toEqual([]);
    expect(decision.plan.trigger_intents).toEqual([]);
  });
});

describe('ID validation', () => {
  const map: SemanticPageMap = {
    state_targets: [
      { id: 'input_1', type: 'text_input', label: 'Input 1', current_value: '' },
    ],
    trigger_elements: [
      { id: 'btn_1', type: 'button_click', label: 'Click Me' },
    ],
  };

  it('validates IDs and strips unknown or hallucinated IDs from the plan', () => {
    const plan: ActionPlan = {
      state_targets: [
        { id: 'input_1', value: 'valid' },
        { id: 'hallucinated_input', value: 'bad' },
      ],
      trigger_intents: [
        { action: 'click', id: 'btn_1' },
        { action: 'click', id: 'hallucinated_btn' },
      ],
    };

    const validation = validatePlanIds(plan, map);

    expect(validation.valid).toBe(false);
    expect(validation.invalidStateIds).toEqual(['hallucinated_input']);
    expect(validation.invalidTriggerIds).toEqual(['hallucinated_btn']);
    expect(validation.plan.state_targets).toEqual([{ id: 'input_1', value: 'valid' }]);
    expect(validation.plan.trigger_intents).toEqual([{ action: 'click', id: 'btn_1' }]);
  });

  it('rejects hallucinated IDs during computePlan execution', async () => {
    const strategy: AgentStrategy = {
      async decide(): Promise<ActionPlan> {
        return {
          state_targets: [{ id: 'ghost_input', value: 'test' }],
          trigger_intents: [{ action: 'click', id: 'ghost_button' }],
        };
      },
    };

    const decision = await computePlan(map, 'Do something' as Goal, strategy);

    expect(decision.state_targets).toEqual([]);
    expect(decision.trigger_intents).toEqual([]);
  });
});

describe('risk scoring', () => {
  it('correctly scores lexical keywords on trigger labels', () => {
    expect(scoreTriggerRisk('Delete Account')).toBe(1.0);
    expect(scoreTriggerRisk('Pay $49.99')).toBe(1.0);
    expect(scoreTriggerRisk('Submit Order')).toBe(1.0);
    expect(scoreTriggerRisk('Checkout now')).toBe(1.0);
    expect(scoreTriggerRisk('Confirm Order')).toBe(1.0);

    expect(scoreTriggerRisk('Submit')).toBe(0.5);
    expect(scoreTriggerRisk('Save profile')).toBe(0.5);
    expect(scoreTriggerRisk('Send message')).toBe(0.5);

    expect(scoreTriggerRisk('Next')).toBe(0.0);
    expect(scoreTriggerRisk('Show more')).toBe(0.0);
    expect(scoreTriggerRisk('Filter results')).toBe(0.0);
    expect(scoreTriggerRisk('')).toBe(0.0);
  });

  it('scores risk for a full plan based on trigger elements in the map', () => {
    const map: SemanticPageMap = {
      state_targets: [],
      trigger_elements: [
        { id: 'btn_delete', type: 'button_click', label: 'Delete Item' },
        { id: 'btn_next', type: 'button_click', label: 'Next Page' },
      ],
    };

    const dangerousPlan: ActionPlan = {
      state_targets: [],
      trigger_intents: [{ action: 'click', id: 'btn_delete' }],
    };

    const safePlan: ActionPlan = {
      state_targets: [],
      trigger_intents: [{ action: 'click', id: 'btn_next' }],
    };

    const emptyPlan: ActionPlan = {
      state_targets: [],
      trigger_intents: [],
    };

    expect(scorePlanRisk(dangerousPlan, map)).toBe(1.0);
    expect(scorePlanRisk(safePlan, map)).toBe(0.0);
    expect(scorePlanRisk(emptyPlan, map)).toBe(0.0);
  });

  it('attaches risk score to PolicyDecision in computePlan', async () => {
    const map: SemanticPageMap = {
      state_targets: [],
      trigger_elements: [
        { id: 'btn_pay', type: 'button_click', label: 'Place Order ($49.99)' },
      ],
    };

    const strategy: AgentStrategy = {
      async decide(): Promise<ActionPlan> {
        return {
          state_targets: [],
          trigger_intents: [{ action: 'click', id: 'btn_pay' }],
        };
      },
    };

    const decision = await computePlan(map, 'Place order', strategy);

    expect(decision.riskScore).toBe(1.0);
    expect(decision.trigger_intents).toHaveLength(1);
    expect(decision.trigger_intents[0].id).toBe('btn_pay');
  });
});

describe('strategy receiving full labeled map', () => {
  it('supplies full labeled map to AgentStrategy.decide', async () => {
    const map: SemanticPageMap = {
      document_id: 'doc_orders',
      title: 'Orders',
      state_targets: [
        { id: 'input_email', type: 'text_input', label: 'Email Address', current_value: '' },
      ],
      trigger_elements: [
        { id: 'btn_submit', type: 'button_click', label: 'Submit Order' },
      ],
    };

    let receivedMap: SemanticPageMap | undefined;
    const strategy: AgentStrategy = {
      name: 'inspector-strategy',
      async decide(observedMap, _goal): Promise<ActionPlan> {
        receivedMap = observedMap;
        return {
          state_targets: [{ id: 'input_email', value: 'test@example.com' }],
          trigger_intents: [{ action: 'click', id: 'btn_submit' }],
        };
      },
    };

    const decision = await computePlan(map, 'Finish order', strategy);

    expect(receivedMap).toBeDefined();
    expect(receivedMap?.state_targets[0].label).toBe('Email Address');
    expect(receivedMap?.trigger_elements[0].label).toBe('Submit Order');
    expect(decision.state_targets[0].value).toBe('test@example.com');
  });
});
