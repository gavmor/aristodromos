import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolvePatchPath,
  applyOperation,
  applyOperationalTransformAsync,
} from '../utils/ot-executor';
import type { Operation } from 'fast-json-patch';

function setupContainer(html: string): HTMLDivElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

function teardownContainer(container?: HTMLDivElement) {
  container?.remove();
}

describe('resolvePatchPath', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = setupContainer(`
      <button id="btn-1">Click me</button>
      <input id="input-1" type="text" />
      <a href="#" id="link-1">Link</a>
    `);
  });

  afterEach(() => teardownContainer(container));

  it('resolves synthetic keys from elementMap', () => {
    const map = new Map<string, Element>();
    const btn = container.querySelector('#btn-1')!;
    map.set('el-btn-0', btn);

    const result = resolvePatchPath('/el-btn-0/clicked', map);
    expect(result).toBe(btn);
  });

  it('returns null for synthetic key not in elementMap', () => {
    const result = resolvePatchPath('/el-btn-99/clicked', new Map());
    expect(result).toBeNull();
  });

  it('falls back to /#id selector when elementMap misses', () => {
    const result = resolvePatchPath('/#btn-1');
    expect(result).toBe(container.querySelector('#btn-1'));
  });

  it('returns null for empty path', () => {
    expect(resolvePatchPath('')).toBeNull();
    expect(resolvePatchPath('/')).toBeNull();
  });

  it('returns null when no elementMap and no selector match', () => {
    const result = resolvePatchPath('/el-btn-0/clicked');
    expect(result).toBeNull();
  });
});

describe('applyOperation', () => {
  let container: HTMLDivElement;
  let btn: HTMLButtonElement;
  let input: HTMLInputElement;
  let elementMap: Map<string, Element>;

  beforeEach(() => {
    container = setupContainer(`
      <button id="btn-1">Click me</button>
      <input id="input-1" type="text" />
    `);
    btn = container.querySelector('#btn-1')!;
    input = container.querySelector('#input-1')!;
    elementMap = new Map();
    elementMap.set('el-btn-0', btn);
    elementMap.set('el-input-1', input);
  });

  afterEach(() => teardownContainer(container));

  it('clicks an element via elementMap', () => {
    let clicked = false;
    btn.addEventListener('click', () => { clicked = true; });

    const op: Operation = { op: 'replace', path: '/el-btn-0/clicked', value: true };
    const result = applyOperation(op, elementMap);
    expect(result).toBe(true);
    expect(clicked).toBe(true);
  });

  it('sets value on an input via elementMap', () => {
    const op: Operation = { op: 'replace', path: '/el-input-1/value', value: 'hello' };
    const result = applyOperation(op, elementMap);
    expect(result).toBe(true);
    expect(input.value).toBe('hello');
  });

  it('fires input and change events when setting value', () => {
    let inputFired = false;
    let changeFired = false;
    input.addEventListener('input', () => { inputFired = true; });
    input.addEventListener('change', () => { changeFired = true; });

    const op: Operation = { op: 'replace', path: '/el-input-1/value', value: 'test' };
    applyOperation(op, elementMap);
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
  });

  it('returns false for unknown operation type', () => {
    const op = { op: 'remove', path: '/el-btn-0/clicked' } as Operation;
    const result = applyOperation(op, elementMap);
    expect(result).toBe(false);
  });

  it('returns false when element not found', () => {
    const op: Operation = { op: 'replace', path: '/el-btn-99/clicked', value: true };
    const result = applyOperation(op, elementMap);
    expect(result).toBe(false);
  });

  it('works without elementMap for /#id paths', () => {
    let clicked = false;
    btn.addEventListener('click', () => { clicked = true; });

    const op: Operation = { op: 'replace', path: '/#btn-1/clicked', value: true };
    const result = applyOperation(op);
    expect(result).toBe(true);
    expect(clicked).toBe(true);
  });

  it('gracefully handles non-existent /#id', () => {
    const op: Operation = { op: 'replace', path: '/#nonexistent/clicked', value: true };
    expect(() => applyOperation(op, elementMap)).not.toThrow();
    expect(applyOperation(op, elementMap)).toBe(false);
  });
});

describe('applyOperationalTransformAsync', () => {
  let container: HTMLDivElement;
  let elementMap: Map<string, Element>;

  beforeEach(() => {
    container = setupContainer(`<button id="btn-1">Click me</button>`);
    const btn = container.querySelector('#btn-1')!;
    elementMap = new Map();
    elementMap.set('el-btn-0', btn);
  });

  afterEach(() => teardownContainer(container));

  it('applies a batch of operations with elementMap', async () => {
    let clicked = false;
    container.querySelector('#btn-1')!.addEventListener('click', () => { clicked = true; });

    const ops: Operation[] = [
      { op: 'replace', path: '/el-btn-0/clicked', value: true },
    ];

    await applyOperationalTransformAsync(ops, new AbortController().signal, elementMap);
    expect(clicked).toBe(true);
  });

  it('rejects if signal is already aborted', async () => {
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      applyOperationalTransformAsync([], aborted.signal, elementMap),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
