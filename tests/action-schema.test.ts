import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildActionSchema } from '../utils/action-schema';
import type { ActionNode, Perception, Scene, StateNode } from '../utils/scene';

const perception = (over: Partial<Perception> = {}): Perception => ({
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
  ...over,
});

const stateNode = (over: Partial<StateNode> & { id: string }): StateNode => ({
  role: 'textbox',
  category: 'state',
  control: 'text',
  value: '',
  relations: {},
  perception: perception(),
  actuation: { setStrategy: 'react-setter', events: ['input', 'change'] },
  ...over,
});

const actionNode = (over: Partial<ActionNode> & { id: string }): ActionNode => ({
  role: 'button',
  category: 'action',
  action: 'click',
  relations: {},
  perception: perception(),
  actuation: { fireStrategy: 'pointer-sequence' },
  ...over,
});

const sceneOf = (...nodes: (StateNode | ActionNode)[]): Scene => ({
  documentId: 'doc1',
  url: 'https://example.test/',
  title: 'test',
  viewport: { w: 800, h: 600, scrollX: 0, scrollY: 0 },
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
});

/** The schema is only useful if a decoder can see it, so assert on JSON Schema. */
const jsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;

describe('buildActionSchema', () => {
  it('returns null when the scene affords nothing actionable', () => {
    expect(buildActionSchema(sceneOf())).toBeNull();
  });

  it('admits a setState on a text node and rejects a value-less one', () => {
    const built = buildActionSchema(sceneOf(stateNode({ id: 'email' })));
    expect(built).not.toBeNull();
    const action = built!.schema;
    expect(action.safeParse({ reasoning: 'x', actions: [{ kind: 'setState', nodeId: 'email', value: 'a@b.c' }] }).success).toBe(true);
    expect(action.safeParse({ reasoning: 'x', actions: [{ kind: 'setState', nodeId: 'email' }] }).success).toBe(false);
  });

  it('makes clickTrigger-with-a-value unrepresentable', () => {
    // This is the exact shape a weak model emitted against a GENERIC schema.
    // The claim is about the GRAMMAR, so assert on the JSON Schema that reaches
    // the decoder — zod's own parse strips unknown keys and would hide it.
    const built = buildActionSchema(sceneOf(stateNode({ id: 'email' }), actionNode({ id: 'submit' })))!;
    const members = (jsonSchema(built.schema).properties as Record<string, { items: { anyOf: Record<string, unknown>[] } }>)
      .actions.items.anyOf;
    const trigger = members.find((m) => {
      const props = m.properties as { kind: { const?: string } };
      return props.kind.const === 'clickTrigger';
    })!;
    expect(Object.keys(trigger.properties as object)).toEqual(['kind', 'nodeId']);
    expect(trigger.additionalProperties).toBe(false);

    // ...and the two id enums are disjoint, so neither verb reaches the other's nodes.
    expect(built.schema.safeParse({ reasoning: 'x', actions: [{ kind: 'clickTrigger', nodeId: 'email' }] }).success).toBe(false);
    expect(built.schema.safeParse({ reasoning: 'x', actions: [{ kind: 'setState', nodeId: 'submit', value: 'x' }] }).success).toBe(false);
  });

  it('drops disabled and modal-inert nodes from the enums', () => {
    const built = buildActionSchema(
      sceneOf(
        stateNode({ id: 'live' }),
        stateNode({ id: 'off', perception: perception({ disabled: true }) }),
        stateNode({ id: 'behind', perception: perception({ inertByModal: true }) }),
        actionNode({ id: 'go' }),
        actionNode({ id: 'greyed', perception: perception({ disabled: true }) }),
      ),
    )!;
    expect(built.stateIds).toEqual(['live']);
    expect(built.triggerIds).toEqual(['go']);
    expect(built.schema.safeParse({ reasoning: '', actions: [{ kind: 'clickTrigger', nodeId: 'greyed' }] }).success).toBe(false);
  });

  it('drops read-only state nodes', () => {
    const built = buildActionSchema(sceneOf(stateNode({ id: 'fixed', readOnly: true }), actionNode({ id: 'go' })))!;
    expect(built.stateIds).toEqual([]);
  });

  it('types value per node: boolean, enum of that node options, bounded number', () => {
    const built = buildActionSchema(
      sceneOf(
        stateNode({ id: 'remember', control: 'boolean', value: false, actuation: { setStrategy: 'toggle-checked' } }),
        stateNode({
          id: 'country',
          control: 'option',
          value: 'us',
          options: [{ value: 'us', label: 'US' }, { value: 'fr', label: 'FR' }],
        }),
        stateNode({ id: 'volume', control: 'range', value: 3, min: 0, max: 10 }),
      ),
    )!;
    const ok = (action: unknown) => built.schema.safeParse({ reasoning: '', actions: [action] }).success;

    expect(ok({ kind: 'setState', nodeId: 'remember', value: true })).toBe(true);
    expect(ok({ kind: 'setState', nodeId: 'remember', value: 'true' })).toBe(false);

    expect(ok({ kind: 'setState', nodeId: 'country', value: 'fr' })).toBe(true);
    expect(ok({ kind: 'setState', nodeId: 'country', value: 'de' })).toBe(false);

    expect(ok({ kind: 'setState', nodeId: 'volume', value: 7 })).toBe(true);
    expect(ok({ kind: 'setState', nodeId: 'volume', value: 99 })).toBe(false);
  });

  it('keeps nodes of the same value type in ONE union member', () => {
    const built = buildActionSchema(
      sceneOf(stateNode({ id: 'a' }), stateNode({ id: 'b' }), stateNode({ id: 'c' }), actionNode({ id: 'go' })),
    )!;
    const emitted = jsonSchema(built.schema);
    const items = (emitted.properties as Record<string, { items: { anyOf?: unknown[] } }>).actions.items;
    // one member for the three text nodes, one for the trigger
    expect(items.anyOf).toHaveLength(2);
  });

  it('emits a schema a GBNF decoder can consume (literals + enums, not free strings)', () => {
    const built = buildActionSchema(sceneOf(stateNode({ id: 'email' }), actionNode({ id: 'submit' })))!;
    const emitted = JSON.stringify(jsonSchema(built.schema));
    expect(emitted).toContain('"const":"setState"');
    expect(emitted).toContain('"const":"clickTrigger"');
    expect(emitted).toContain('"email"');
    expect(emitted).toContain('"submit"');
  });
});
