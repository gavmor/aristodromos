import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAXTree, distillAXTreeToSchema } from '../utils/dom-snapshot';
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

describe('buildAXTree', () => {
  let container: HTMLDivElement;

  /** Count how many allowedPaths start with a given element key prefix */
  function countPaths(paths: string[], prefix: string): number {
    return paths.filter((p) => p.startsWith(`/${prefix}`)).length;
  }

  beforeEach(() => {
    container = document.createElement('div');
    container.innerHTML = `
      <a href="#" id="el-link">standard link</a>
      <a onclick="return false" id="el-jslink">js link</a>
      <button id="el-btn">button</button>
      <input type="text" id="el-input">
      <textarea id="el-textarea"></textarea>
      <select id="el-select"><option>1</option></select>
      <div role="button" tabindex="0" id="el-aria-btn">ARIA button</div>
      <span onclick="alert(1)" id="el-clickable-span">clickable span</span>
      <div tabindex="0" id="el-focusable-div">focusable div</div>
      <div contenteditable="true" id="el-contenteditable">editable</div>
    `;
    document.body.appendChild(container);
  });

  afterEach(() => {
    container?.remove();
  });

  it('detects all interactive element types including links', () => {
    const { axNode, elementMap } = buildAXTree();
    const { schema } = distillAXTreeToSchema(axNode);

    const pathSet = new Set(schema.allowedPaths);

    // <a> links
    expect(pathSet).toContain('/el-a-0/clicked');
    expect(pathSet).toContain('/el-a-1/clicked');

    // Tag-based elements produce correct paths
    expect(schema.allowedPaths.some((p) => p.startsWith('/el-button-') && p.endsWith('/clicked'))).toBe(true);
    expect(schema.allowedPaths.some((p) => p.startsWith('/el-input-') && p.endsWith('/value'))).toBe(true);
    expect(schema.allowedPaths.some((p) => p.startsWith('/el-textarea-') && p.endsWith('/value'))).toBe(true);
    expect(schema.allowedPaths.some((p) => p.startsWith('/el-select-') && p.endsWith('/clicked'))).toBe(true);

    // ARIA role / tabindex elements
    expect(schema.allowedPaths.some((p) => p.startsWith('/el-div-') && p.endsWith('/clicked'))).toBe(true);

    // Elements querySelectorAll previously MISSED:
    // <span onclick="..."> — no native tag, no tabindex
    expect(schema.allowedPaths.some((p) => p.startsWith('/el-span-') && p.endsWith('/clicked'))).toBe(true);
    // <div contenteditable="true"> — not previously detected, is input affordance
    expect(schema.allowedPaths.some((p) => p.startsWith('/el-div-') && p.endsWith('/value'))).toBe(true);

    // elementMap has entries for all 10 interactive elements
    expect(elementMap.size).toBe(10);
  });
});
