// Scene -> action schema. Built fresh for EVERY decision, because the set of
// legal actions is a fact about the live page, not a constant.
//
// The shape is a DISCRIMINATED UNION, not a generic `(nodeId, value)` pair:
//
//   { kind: 'setState',     nodeId: <enum of state ids>,   value: <typed per node> }
//   { kind: 'clickTrigger', nodeId: <enum of trigger ids> }                 // no value
//
// That distinction is load-bearing. A generic schema is satisfied by
// `clickTrigger` on a text field carrying a value — a combination that means
// nothing, which a weak local model will happily emit. Here it is not
// REPRESENTABLE: the decoder cannot produce it, so it never has to be rejected
// downstream. Unreachable nodes (disabled, or inert behind a modal) are dropped
// from the enums for the same reason — they are reported in the Scene (fidelity)
// but excluded from the grammar (legality).
//
// This schema goes to Ollama's `format`, which compiles it to GBNF and
// constrains decoding. The constraint is enforced by the sampler, not by a
// post-hoc validator and not by the model's goodwill.
import { z } from 'zod';
import type { ActionNode, Scene, SceneNode, StateNode } from './scene';

/** What the brain emits; mirrors the content script's two capabilities 1:1. */
export type PlanAction =
  | { kind: 'setState'; nodeId: string; value: string | number | boolean }
  | { kind: 'clickTrigger'; nodeId: string };

export interface Plan {
  /** short rationale, decoded BEFORE the actions so it can actually inform them */
  reasoning: string;
  /** empty = nothing left to do for the goal on this Scene */
  actions: PlanAction[];
}

export const isStateNode = (n: SceneNode): n is StateNode => n.category === 'state';
export const isActionNode = (n: SceneNode): n is ActionNode => n.category === 'action';

/**
 * Perceptually reachable RIGHT NOW. `disabled` and `inertByModal` are the two
 * facts that make an otherwise-present node unactuatable, so they gate the enum.
 */
export function isReachable(node: SceneNode): boolean {
  return !node.perception.disabled && !node.perception.inertByModal;
}

/** The value type a particular state node will accept. */
type ValueShape =
  | { tag: 'string' }
  | { tag: 'boolean' }
  | { tag: 'number'; min?: number; max?: number }
  | { tag: 'enum'; options: string[] };

function valueShapeOf(node: StateNode): ValueShape {
  if (node.control === 'boolean') return { tag: 'boolean' };
  if (node.control === 'range' || node.control === 'scroll') {
    return { tag: 'number', min: node.min, max: node.max };
  }
  const options = node.options?.map((o) => o.value).filter((v) => v !== '');
  if (node.control === 'option' && options && options.length > 0) {
    return { tag: 'enum', options };
  }
  return { tag: 'string' };
}

/** zod enums need a non-empty tuple; keep the one widening cast here. */
function asTuple(values: string[]): [string, ...string[]] {
  if (values.length === 0) throw new Error('refusing to build an empty enum');
  return values as [string, ...string[]];
}

function valueSchema(shape: ValueShape): z.ZodType {
  switch (shape.tag) {
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum(asTuple(shape.options));
    case 'number': {
      let n = z.number();
      if (shape.min !== undefined) n = n.min(shape.min);
      if (shape.max !== undefined) n = n.max(shape.max);
      return n;
    }
    case 'string':
      return z.string();
  }
}

/**
 * Nodes that accept the same value type collapse into one union member, so the
 * grammar stays small: `nodeId` is an enum of just those ids, and `value` is
 * typed for exactly them. One member per distinct value type, not per node.
 */
function groupByValueShape(nodes: StateNode[]): Map<string, { shape: ValueShape; ids: string[] }> {
  const groups = new Map<string, { shape: ValueShape; ids: string[] }>();
  for (const node of nodes) {
    const shape = valueShapeOf(node);
    const key = JSON.stringify(shape);
    const bucket = groups.get(key);
    if (bucket) bucket.ids.push(node.id);
    else groups.set(key, { shape, ids: [node.id] });
  }
  return groups;
}

export interface ActionSchema {
  /** the zod schema handed to generateObject -> Ollama `format` -> GBNF */
  schema: z.ZodType;
  /** every state id the schema admits */
  stateIds: string[];
  /** every trigger id the schema admits */
  triggerIds: string[];
}

/**
 * Build the per-decision schema. Returns null when the Scene affords nothing —
 * an empty enum is not a legal grammar, and "no legal action" is a real state
 * the caller must handle rather than paper over.
 */
export function buildActionSchema(scene: Scene): ActionSchema | null {
  const reachable = Object.values(scene.nodes).filter(isReachable);
  const stateNodes = reachable.filter(isStateNode).filter((n) => !n.readOnly);
  const triggerNodes = reachable.filter(isActionNode);

  const members: z.ZodType[] = [];

  for (const { shape, ids } of groupByValueShape(stateNodes).values()) {
    members.push(
      z.object({
        kind: z.literal('setState'),
        nodeId: z.enum(asTuple(ids)),
        value: valueSchema(shape),
      }),
    );
  }

  if (triggerNodes.length > 0) {
    members.push(
      z.object({
        kind: z.literal('clickTrigger'),
        nodeId: z.enum(asTuple(triggerNodes.map((n) => n.id))),
      }),
    );
  }

  if (members.length === 0) return null;

  // z.union needs two members; a single-member union is just that member.
  const action =
    members.length === 1 ? members[0] : z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]]);

  return {
    schema: z.object({
      reasoning: z.string(),
      actions: z.array(action),
    }),
    stateIds: stateNodes.map((n) => n.id),
    triggerIds: triggerNodes.map((n) => n.id),
  };
}
