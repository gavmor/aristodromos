import { Actuation } from './scene';

/**
 * The event order complex/custom widgets listen for to actually open or activate.
 * Vendored (not a user-event dependency) — it is just a known sequence.
 */
export const POINTER_SEQUENCE = [
  'pointerover',
  'pointerenter',
  'pointerdown',
  'mousedown',
  'focus',
  'pointerup',
  'mouseup',
  'click',
];

/** Derive the correct actuation recipe for an element from its type. Pure. */
export function deriveActuation(el: Element): Actuation {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();

  if (tag === 'select') {
    return { setStrategy: 'select-option', events: ['input', 'change'] };
  }
  if (tag === 'textarea') {
    return { setStrategy: 'react-setter', events: ['input', 'change'] };
  }
  if (tag === 'input') {
    if (type === 'checkbox' || type === 'radio') {
      return {
        setStrategy: 'toggle-checked',
        fireStrategy: 'native-click',
        events: ['click', 'input', 'change'],
      };
    }
    return { setStrategy: 'react-setter', events: ['input', 'change'] };
  }
  if ((el as HTMLElement).isContentEditable) {
    return { setStrategy: 'native-value', events: ['beforeinput', 'input'] };
  }
  // Default: a trigger. Custom widgets often need the full pointer sequence.
  return { fireStrategy: 'pointer-sequence', events: POINTER_SEQUENCE };
}

/**
 * React/Vue track an input's value via a hidden setter; writing through the
 * native prototype setter bypasses that tracker so a dispatched 'input' is
 * actually observed by the framework. The setter is per element class.
 */
export function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** Create the right event class for a given type (jsdom lacks PointerEvent). */
function makeEvent(type: string): Event {
  const init: EventInit = { bubbles: true, cancelable: true };
  if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
    return new PointerEvent(type, init);
  }
  if (type.startsWith('mouse') || type === 'click') {
    return new MouseEvent(type, init);
  }
  return new Event(type, init);
}

/** Dispatch a named event sequence, bubbling, in order. */
export function dispatchSequence(el: Element, events: string[]): void {
  for (const type of events) el.dispatchEvent(makeEvent(type));
}
