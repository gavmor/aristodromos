import { describe, it, expect, beforeEach } from 'vitest';
import {
  deriveActuation,
  setNativeValue,
  dispatchSequence,
  POINTER_SEQUENCE,
} from '../utils/actuation';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('deriveActuation', () => {
  it('uses select-option for <select>', () => {
    expect(deriveActuation(document.createElement('select')).setStrategy).toBe('select-option');
  });

  it('uses the react-setter for text inputs and textareas', () => {
    const input = document.createElement('input');
    input.type = 'text';
    expect(deriveActuation(input).setStrategy).toBe('react-setter');
    expect(deriveActuation(document.createElement('textarea')).setStrategy).toBe('react-setter');
  });

  it('toggles checked for checkboxes', () => {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    expect(deriveActuation(cb).setStrategy).toBe('toggle-checked');
  });

  it('falls back to the pointer sequence for buttons and custom triggers', () => {
    const recipe = deriveActuation(document.createElement('button'));
    expect(recipe.fireStrategy).toBe('pointer-sequence');
    expect(recipe.events).toEqual(POINTER_SEQUENCE);
  });
});

describe('setNativeValue', () => {
  it('writes through the native prototype setter', () => {
    const input = document.createElement('input');
    setNativeValue(input, 'hello');
    expect(input.value).toBe('hello');
  });
});

describe('dispatchSequence', () => {
  it('fires each event in order, bubbling', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const seen: string[] = [];
    for (const type of ['pointerdown', 'mouseup', 'click']) {
      el.addEventListener(type, () => seen.push(type));
    }
    dispatchSequence(el, ['pointerdown', 'mouseup', 'click']);
    expect(seen).toEqual(['pointerdown', 'mouseup', 'click']);
  });
});
