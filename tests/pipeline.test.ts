import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { distillAXTreeToSchema, buildAXTree } from '../utils/dom-snapshot';
import { RandomClickStrategy } from '../utils/random-click-strategy';
import { LLMStrategy } from '../utils/agent';
import { resolvePatchPath, applyOperation, applyOperationalTransformAsync } from '../utils/ot-executor';
import type { AXNode, OperationSchema } from '../utils/types';
import type { Operation } from 'fast-json-patch';

// ---------------------------------------------------------------------------
// Pipeline: distillAXTreeToSchema → RandomClickStrategy.decide()
// ---------------------------------------------------------------------------

describe('Pipeline: distill → RandomClickStrategy', () => {
  const strategy = new RandomClickStrategy();

  it('produces a click operation when schema has clickable paths', async () => {
    const axNode: AXNode = {
      role: 'WebArea',
      name: 'Test',
      children: {
        'el-btn-0': { role: 'button', affordance: 'click', name: 'Submit' },
        'el-input-1': { role: 'textbox', affordance: 'input', name: 'Name' },
      },
    };

    const { schema } = distillAXTreeToSchema(axNode);
    expect(schema.allowedPaths).toContain('/el-btn-0/clicked');

    const result = await strategy.decide(schema, [], new AbortController().signal);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].path).toMatch(/\/clicked$/);
  });

  it('returns empty operations when schema has only inputs (no clickables)', async () => {
    const axNode: AXNode = {
      role: 'WebArea',
      name: 'Test',
      children: {
        'el-input-1': { role: 'textbox', affordance: 'input', name: 'Name' },
        'el-textarea-2': { role: 'textbox', affordance: 'input', name: 'Bio' },
      },
    };

    const { schema } = distillAXTreeToSchema(axNode);
    expect(schema.allowedPaths.every((p) => !p.endsWith('/clicked'))).toBe(true);

    const result = await strategy.decide(schema, [], new AbortController().signal);
    expect(result.operations).toHaveLength(0);
    expect(result.reasoning).toContain('No clickable');
  });

  it('handles the fallback /no-elements path gracefully', async () => {
    const axNode: AXNode = { role: 'WebArea', name: 'Empty', children: {} };

    const { schema } = distillAXTreeToSchema(axNode);
    expect(schema.allowedPaths).toEqual(['/no-elements']);

    const result = await strategy.decide(schema, [], new AbortController().signal);
    expect(result.operations).toHaveLength(0);
  });

  it('produces click operations deterministically when only one clickable exists', async () => {
    const axNode: AXNode = {
      role: 'WebArea',
      name: 'Test',
      children: {
        'el-btn-0': { role: 'button', affordance: 'click', name: 'Only Button' },
      },
    };

    const { schema } = distillAXTreeToSchema(axNode);
    const result = await strategy.decide(schema, [], new AbortController().signal);

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].path).toBe('/el-btn-0/clicked');
    expect((result.operations[0] as any).value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pipeline: RandomClickStrategy.decide() → applyOperation()
// ---------------------------------------------------------------------------

describe('Pipeline: RandomClickStrategy → OT execution', () => {
  let container: HTMLDivElement;
  let btn: HTMLButtonElement;
  let elementMap: Map<string, Element>;

  beforeEach(() => {
    container = document.createElement('div');
    container.innerHTML = `<button id="btn-1">Click me</button>`;
    document.body.appendChild(container);
    btn = container.querySelector('#btn-1')!;
    elementMap = new Map();
    elementMap.set('el-btn-0', btn);
  });

  afterEach(() => {
    container?.remove();
  });

  it('strategy output resolves to a real DOM click via elementMap', async () => {
    const schema: OperationSchema = {
      allowedPaths: ['/el-btn-0/clicked'],
      allowedOperations: ['replace'],
      description: 'Test',
    };

    // Strategy decides
    const decision = await new RandomClickStrategy().decide(
      schema, [], new AbortController().signal,
    );

    // OT executor applies
    let clicked = false;
    btn.addEventListener('click', () => { clicked = true; });

    for (const op of decision.operations) {
      applyOperation(op, elementMap);
    }

    expect(clicked).toBe(true);
  });

  it('empty operations from strategy result in no DOM interaction', async () => {
    const schema: OperationSchema = {
      allowedPaths: [],
      allowedOperations: ['replace'],
      description: 'No elements',
    };

    const decision = await new RandomClickStrategy().decide(
      schema, [], new AbortController().signal,
    );

    expect(decision.operations).toHaveLength(0);

    // No operations to apply — no click should fire
    let clicked = false;
    btn.addEventListener('click', () => { clicked = true; });

    expect(clicked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pipeline: distillAXTreeToSchema → resolvePatchPath (elementMap flow)
// ---------------------------------------------------------------------------

describe('Pipeline: distill → resolvePatchPath', () => {
  let container: HTMLDivElement;
  let btn: HTMLButtonElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.innerHTML = `<button id="btn-1">Click here</button>`;
    document.body.appendChild(container);
    btn = container.querySelector('#btn-1')!;
  });

  afterEach(() => {
    container?.remove();
  });

  it('a path generated by distillAXTreeToSchema resolves via elementMap', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      name: 'Test',
      children: {
        'el-btn-0': { role: 'button', affordance: 'click', name: 'Click here' },
      },
    };

    const { schema } = distillAXTreeToSchema(axNode);
    const path = schema.allowedPaths[0]; // "/el-btn-0/clicked"

    const map = new Map<string, Element>();
    map.set('el-btn-0', btn);

    const resolved = resolvePatchPath(path, map);
    expect(resolved).toBe(btn);
  });
});
