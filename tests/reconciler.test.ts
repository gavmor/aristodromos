import { beforeEach, describe, expect, it } from 'vitest';
import { applyPlan, didMove, summarize } from '../utils/reconciler';
import { SceneProjector } from '../utils/scene-projector';
import type { PlanAction } from '../utils/action-schema';

/**
 * These run against a REAL projector over a real (jsdom) DOM, not a mocked
 * resolver: the whole point of the down-edge is that a NodeId minted during
 * perception still resolves to the right element at actuation time.
 */
function mount(html: string): { projector: SceneProjector; idOf: (selector: string) => string } {
  document.body.innerHTML = html;
  const projector = new SceneProjector({ root: document, emit: () => {}, schedule: (cb) => cb() });
  projector.scan();
  const idOf = (selector: string): string => {
    const el = document.querySelector(selector)!;
    const found = Object.values(projector.current.nodes).find((n) => projector.elementFor(n.id) === el);
    if (!found) throw new Error(`no scene node for ${selector}`);
    return found.id;
  };
  return { projector, idOf };
}

const depsFor = (projector: SceneProjector) => ({
  resolve: (id: string) => projector.elementFor(id),
  nodeOf: (id: string) => projector.nodeOf(id),
});

describe('reconciler', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('writes a text field through the native setter and fires input/change', () => {
    const { projector, idOf } = mount('<input aria-label="Email" />');
    const input = document.querySelector('input')!;
    const seen: string[] = [];
    for (const type of ['input', 'change']) input.addEventListener(type, () => seen.push(type));

    const results = applyPlan([{ kind: 'setState', nodeId: idOf('input'), value: 'alice@example.com' }], depsFor(projector));

    expect(input.value).toBe('alice@example.com');
    expect(seen).toEqual(['input', 'change']);
    expect(results[0].status).toBe('applied');
  });

  it('reports an already-correct value as a noop instead of re-applying', () => {
    const { projector, idOf } = mount('<input aria-label="Email" value="alice@example.com" />');
    const input = document.querySelector('input')!;
    let fired = 0;
    input.addEventListener('input', () => (fired += 1));

    const results = applyPlan([{ kind: 'setState', nodeId: idOf('input'), value: 'alice@example.com' }], depsFor(projector));

    expect(results[0].status).toBe('noop');
    expect(fired).toBe(0);
  });

  it('toggles a checkbox through the checked property', () => {
    const { projector, idOf } = mount('<input type="checkbox" aria-label="Remember" />');
    applyPlan([{ kind: 'setState', nodeId: idOf('input'), value: true }], depsFor(projector));
    expect(document.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
  });

  it('selects an option by value', () => {
    const { projector, idOf } = mount('<select aria-label="Country"><option value="us">US</option><option value="fr">FR</option></select>');
    applyPlan([{ kind: 'setState', nodeId: idOf('select'), value: 'fr' }], depsFor(projector));
    expect(document.querySelector<HTMLSelectElement>('select')!.value).toBe('fr');
  });

  it('drives a trigger with the full pointer sequence, in order', () => {
    const { projector, idOf } = mount('<div role="button" tabindex="0">Go</div>');
    const seen: string[] = [];
    const el = document.querySelector('[role=button]')!;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.addEventListener(type, () => seen.push(type));
    }
    applyPlan([{ kind: 'clickTrigger', nodeId: idOf('[role=button]') }], depsFor(projector));
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  it('applies a multi-action plan in the order given', () => {
    const { projector, idOf } = mount('<form><input aria-label="Email" /><button type="button">Go</button></form>');
    const order: string[] = [];
    document.querySelector('input')!.addEventListener('input', () => order.push('input'));
    document.querySelector('button')!.addEventListener('click', () => order.push('click'));

    const plan: PlanAction[] = [
      { kind: 'setState', nodeId: idOf('input'), value: 'alice@example.com' },
      { kind: 'clickTrigger', nodeId: idOf('button') },
    ];
    const results = applyPlan(plan, depsFor(projector));

    expect(order).toEqual(['input', 'click']);
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
  });

  it('reports a node the page has replaced as stale rather than failing silently', () => {
    const { projector, idOf } = mount('<input aria-label="Email" />');
    const id = idOf('input');
    document.body.innerHTML = '<p>gone</p>';

    const results = applyPlan([{ kind: 'setState', nodeId: id, value: 'x' }], depsFor(projector));
    expect(results[0].status).toBe('stale');
  });

  it('refuses a verb aimed at the wrong category of node', () => {
    const { projector, idOf } = mount('<form><input aria-label="Email" /><button type="button">Go</button></form>');
    const results = applyPlan([{ kind: 'clickTrigger', nodeId: idOf('input') }], depsFor(projector));
    expect(results[0].status).toBe('rejected');
    expect(summarize(results)).toContain('rejected');
  });

  it('refuses to click a disabled trigger even if a plan names it', () => {
    const { projector, idOf } = mount('<button type="button" disabled>Go</button>');
    let clicked = 0;
    document.querySelector('button')!.addEventListener('click', () => (clicked += 1));
    const results = applyPlan([{ kind: 'clickTrigger', nodeId: idOf('button') }], depsFor(projector));
    expect(results[0].status).toBe('rejected');
    expect(clicked).toBe(0);
  });

  describe('didMove', () => {
    it('separates a stalled turn from a finished one', () => {
      const { projector, idOf } = mount('<input aria-label="Email" value="alice@example.com" />');
      const id = idOf('input');

      // nothing emitted: genuinely finished
      expect(didMove(applyPlan([], depsFor(projector)))).toBe(false);

      // emitted, but every action was already satisfied: STALLED, not finished
      expect(didMove(applyPlan([{ kind: 'setState', nodeId: id, value: 'alice@example.com' }], depsFor(projector)))).toBe(false);

      // one real change is enough to count as progress
      expect(didMove(applyPlan([{ kind: 'setState', nodeId: id, value: 'bob@example.com' }], depsFor(projector)))).toBe(true);
    });

    it('treats a stale or rejected action as no movement', () => {
      const { projector, idOf } = mount('<button type="button" disabled>Go</button><input aria-label="E" />');
      const gone = idOf('input');
      document.querySelector('input')!.remove();
      expect(didMove(applyPlan([{ kind: 'clickTrigger', nodeId: idOf('button') }], depsFor(projector)))).toBe(false);
      expect(didMove(applyPlan([{ kind: 'setState', nodeId: gone, value: 'x' }], depsFor(projector)))).toBe(false);
    });
  });
});
