import { describe, it, expect } from 'vitest';
import { distillAXTreeToSchema } from '../utils/dom-snapshot';
import type { AXNode } from '../utils/types';

describe('distillAXTreeToSchema', () => {
  it('produces paths for buttons', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      name: 'Test',
      children: {
        'el-btn-0': { role: 'button', name: 'Submit' },
        'el-btn-1': { role: 'button', name: 'Cancel' },
      },
    };

    const { scene, schema } = distillAXTreeToSchema(axNode);

    expect(schema.allowedPaths).toContain('/el-btn-0/clicked');
    expect(schema.allowedPaths).toContain('/el-btn-1/clicked');
    expect(schema.allowedOperations).toEqual(['replace']);
  });

  it('produces value paths for textboxes', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      name: 'Form',
      children: {
        'el-input-0': { role: 'textbox', name: 'Username' },
      },
    };

    const { scene, schema } = distillAXTreeToSchema(axNode);

    expect(schema.allowedPaths).toContain('/el-input-0/value');
    expect(schema.allowedPaths).not.toContain('/el-input-0/clicked');
  });

  it('handles mixed element types', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      children: {
        'el-btn-0': { role: 'button' },
        'el-input-1': { role: 'textbox', value: '' },
        'el-chk-2': { role: 'checkbox' },
        'el-span-3': { role: 'text' }, // non-interactive
      },
    };

    const { scene, schema } = distillAXTreeToSchema(axNode);

    expect(schema.allowedPaths).toEqual([
      '/el-btn-0/clicked',
      '/el-input-1/value',
      '/el-chk-2/clicked',
    ]);
    // el-span-3 is not a button, checkbox, textbox, or input → excluded
    expect(schema.allowedPaths).not.toContain('/el-span-3/clicked');
    expect(schema.allowedPaths).not.toContain('/el-span-3/value');
  });

  it('returns /no-elements when no interactables exist', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      children: {
        'el-div-0': { role: 'text' },
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
      children: { 'el-btn-0': { role: 'button' } },
    };

    const { scene } = distillAXTreeToSchema(axNode);

    expect(scene.metadataMap.get('interactiveNodeCount')).toBe(1);
    expect(scene.metadataMap.get('scanTimestamp')).toBeInstanceOf(Date);
  });

  it('preserves affordances as the children record', () => {
    const axNode: AXNode = {
      role: 'WebArea',
      children: { 'el-btn-0': { role: 'button', name: 'Go' } },
    };

    const { scene } = distillAXTreeToSchema(axNode);

    expect(scene.affordances).toEqual(axNode.children);
    expect((scene.affordances['el-btn-0'] as any).name).toBe('Go');
  });
});
