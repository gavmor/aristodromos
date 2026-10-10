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

interface JsonObject {
  properties: Record<string, { items?: { anyOf?: Record<string, unknown>[] }; minItems?: number }>;
  additionalProperties?: boolean;
}

/** The plan's two branches as the decoder sees them: the one that acts, and `done`. */
const branches = (schema: z.ZodType): { act: JsonObject; done: JsonObject } => {
  const all = jsonSchema(schema).anyOf as JsonObject[];
  return {
    act: all.find((b) => 'actions' in b.properties)!,
    done: all.find((b) => 'done' in b.properties)!,
  };
};

describe('buildActionSchema', () => {
  it('returns null when the scene affords nothing actionable', () => {
    expect(buildActionSchema(sceneOf())).toBeNull();
  });

  it('has no empty plan: it acts at least once, or declares the goal done', () => {
    const built = buildActionSchema(sceneOf(actionNode({ id: 'go' })))!;
    const { act, done } = branches(built.schema);
    expect(act.properties.actions.minItems).toBe(1);
    expect(Object.keys(done.properties)).toEqual(['satisfied', 'done']);
    expect(done.additionalProperties).toBe(false);

    expect(built.schema.safeParse({ satisfied: '', remaining: 'x', actions: [] }).success).toBe(false);
    expect(built.schema.safeParse({ satisfied: 'all of it', done: true }).success).toBe(true);
    expect(built.schema.safeParse({ satisfied: 'all of it', done: false }).success).toBe(false);
  });

  it('admits a setState on a text node and rejects a value-less one', () => {
    const built = buildActionSchema(sceneOf(stateNode({ id: 'email' })));
    expect(built).not.toBeNull();
    const action = built!.schema;
    expect(action.safeParse({ satisfied: '', remaining: 'x', actions: [{ kind: 'setState', nodeId: 'email', value: 'a@b.c' }] }).success).toBe(true);
    expect(action.safeParse({ satisfied: '', remaining: 'x', actions: [{ kind: 'setState', nodeId: 'email' }] }).success).toBe(false);
  });

  it('makes clickTrigger-with-a-value unrepresentable', () => {
    // This is the exact shape a weak model emitted against a GENERIC schema.
    // The claim is about the GRAMMAR, so assert on the JSON Schema that reaches
    // the decoder — zod's own parse strips unknown keys and would hide it.
    const built = buildActionSchema(sceneOf(stateNode({ id: 'email' }), actionNode({ id: 'submit' })))!;
    const members = branches(built.schema).act.properties.actions.items!.anyOf!;
    const trigger = members.find((m) => {
      const props = m.properties as { kind: { const?: string } };
      return props.kind.const === 'clickTrigger';
    })!;
    expect(Object.keys(trigger.properties as object)).toEqual(['kind', 'nodeId']);
    expect(trigger.additionalProperties).toBe(false);

    // ...and the two id enums are disjoint, so neither verb reaches the other's nodes.
    expect(built.schema.safeParse({ satisfied: '', remaining: 'x', actions: [{ kind: 'clickTrigger', nodeId: 'email' }] }).success).toBe(false);
    expect(built.schema.safeParse({ satisfied: '', remaining: 'x', actions: [{ kind: 'setState', nodeId: 'submit', value: 'x' }] }).success).toBe(false);
  });

  it('does not offer javascript: links, which the content script cannot follow', () => {
    const built = buildActionSchema(
      sceneOf(
        actionNode({ id: 'save', href: 'javascript: PostBack(\'Save\');' }),
        actionNode({ id: 'back', href: ' JavaScript:history.go(-1)' }),
        actionNode({ id: 'choice', href: '#' }),
      ),
    )!;
    expect(built.triggerIds).toEqual(['choice']);
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
    expect(built.schema.safeParse({ satisfied: '', remaining: '', actions: [{ kind: 'clickTrigger', nodeId: 'greyed' }] }).success).toBe(false);
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
    const ok = (action: unknown) => built.schema.safeParse({ satisfied: '', remaining: '', actions: [action] }).success;

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
    const items = branches(built.schema).act.properties.actions.items!;
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
