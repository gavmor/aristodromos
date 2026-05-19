import { describe, it, expect } from 'vitest';
import { distillAXTreeToSchema } from '../utils/dom-snapshot';
import type { AXNode } from '../utils/types';

describe('distillAXTreeToSchema', () => {
  it('produces click paths for clickable elements', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      name: 'Test',
      children: {
        'el-btn-0': { role: 'button', affordance: 'click', name: 'Submit' },
        'el-link-1': { role: 'link', affordance: 'click', name: 'Click here' },
      },
    };

    const { schema } = distillAXTreeToSchema(axNode);

    expect(schema.allowedPaths).toContain('/el-btn-0/clicked');
    expect(schema.allowedPaths).toContain('/el-link-1/clicked');
    expect(schema.allowedOperations).toEqual(['replace']);
  });

  it('produces value paths for input elements', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      name: 'Form',
      children: {
        'el-input-0': { role: 'textbox', affordance: 'input', name: 'Username' },
        'el-textarea-1': { role: 'textbox', affordance: 'input', value: '' },
      },
    };

    const { schema } = distillAXTreeToSchema(axNode);

    expect(schema.allowedPaths).toContain('/el-input-0/value');
    expect(schema.allowedPaths).toContain('/el-textarea-1/value');
    expect(schema.allowedPaths).not.toContain('/el-input-0/clicked');
  });

  it('handles mixed element types', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      children: {
        'el-btn-0': { role: 'button', affordance: 'click' },
        'el-input-1': { role: 'textbox', affordance: 'input', value: '' },
        'el-chk-2': { role: 'checkbox', affordance: 'click' },
        'el-link-3': { role: 'link', affordance: 'click', name: 'Click here' },
        'el-span-4': { role: 'text' }, // no affordance → non-interactive
      },
    };

    const { schema } = distillAXTreeToSchema(axNode);

    expect(schema.allowedPaths).toEqual([
      '/el-btn-0/clicked',
      '/el-input-1/value',
      '/el-chk-2/clicked',
      '/el-link-3/clicked',
    ]);
    // el-span-4 has no affordance → excluded
    expect(schema.allowedPaths).not.toContain('/el-span-4/clicked');
    expect(schema.allowedPaths).not.toContain('/el-span-4/value');
  });

  it('returns /no-elements when no interactables exist', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      children: {
        'el-div-0': { role: 'text' }, // no affordance → excluded
      },
    };

    const { schema } = distillAXTreeToSchema(axNode);
    expect(schema.allowedPaths).toEqual(['/no-elements']);
  });

  it('handles empty children', () => {
    const axNode: AXNode = { role: 'WebArea' };

    const { scene, schema } = distillAXTreeToSchema(axNode);

    expect(schema.allowedPaths).toEqual(['/no-elements']);
    expect(scene.metadataMap.get('interactiveNodeCount')).toBe(0);
  });

  it('populates metadata Map with timestamp and count', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      children: { 'el-btn-0': { role: 'button', affordance: 'click' } },
    };

    const { scene } = distillAXTreeToSchema(axNode);

    expect(scene.metadataMap.get('interactiveNodeCount')).toBe(1);
    expect(scene.metadataMap.get('scanTimestamp')).toBeInstanceOf(Date);
  });

  it('preserves affordances as the children record', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      children: { 'el-btn-0': { role: 'button', affordance: 'click', name: 'Go' } },
    };

    const { scene } = distillAXTreeToSchema(axNode);

    expect(scene.affordances).toEqual(axNode.children);
    expect((scene.affordances['el-btn-0'] as any).name).toBe('Go');
  });
});
