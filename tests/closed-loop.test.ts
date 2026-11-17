import { describe, expect, it, vi } from 'vitest';
import { SceneProjector } from '../utils/scene-projector';
import { applyPlan } from '../utils/reconciler';
import { createSystemOneBrain } from '../utils/system-one-brain';
import { ACTION_QUESTION, DONE_QUESTION, buildActionQuestions } from '../utils/system-one-questions';
import type { ScenePatch, StateNode } from '../utils/scene';

/**
 * The one closed-loop invariant the whole design rests on: after the down-edge
 * writes a value, the NEXT observation must report that value. The loop is
 * memoryless, so a Scene that reports a stale `value` tells the brain the field
 * is still empty and it re-fills it forever. Nothing else catches this — the DOM
 * really did change, and the unit tests for each half really do pass.
 */
describe('value changes reach the up-edge', () => {
  it('re-projects a text field after the reconciler writes it', () => {
    document.body.innerHTML = '<label for="email">Email</label><input id="email" />';
    const emitted: ScenePatch[] = [];
    const projector = new SceneProjector({
      root: document,
      emit: (patch) => emitted.push(patch),
      schedule: (cb) => cb(),
    });
    projector.scan();
    projector.start();

    const node = Object.values(projector.current.nodes).find((n) => n.name === 'Email')!;
    expect((node as StateNode).value).toBe('');

    applyPlan([{ kind: 'setState', nodeId: node.id, value: 'alice@example.com' }], {
      resolve: (id) => projector.elementFor(id),
      nodeOf: (id) => projector.nodeOf(id),
    });

    // the in-memory Scene, which is what the background's replica is folded from
    expect((projector.current.nodes[node.id] as StateNode).value).toBe('alice@example.com');

    // ...and it went out as a targeted op, not a whole-scene resend
    const ops = emitted.flatMap((p) => (p.kind === 'patch' ? p.ops : []));
    expect(ops).toContainEqual({ op: 'replace', path: `/nodes/${node.id}/value`, value: 'alice@example.com' });

    projector.stop();
  });

  it('re-projects a checkbox after the reconciler toggles it', () => {
    document.body.innerHTML = '<label for="r">Remember</label><input id="r" type="checkbox" />';
    const projector = new SceneProjector({ root: document, emit: () => {}, schedule: (cb) => cb() });
    projector.scan();
    projector.start();

    const node = Object.values(projector.current.nodes).find((n) => n.name === 'Remember')!;
    applyPlan([{ kind: 'setState', nodeId: node.id, value: true }], {
      resolve: (id) => projector.elementFor(id),
      nodeOf: (id) => projector.nodeOf(id),
    });

    expect((projector.current.nodes[node.id] as StateNode).value).toBe(true);
    projector.stop();
  });

  it('stops listening after stop()', () => {
    document.body.innerHTML = '<input id="x" aria-label="X" />';
    const emitted: ScenePatch[] = [];
    const projector = new SceneProjector({ root: document, emit: (p) => emitted.push(p), schedule: (cb) => cb() });
    projector.scan();
    projector.start();
    projector.stop();
    emitted.length = 0;

    document.getElementById('x')!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(emitted).toHaveLength(0);
  });
});

describe('a playbook lands in one applyPlan', () => {
  it('sets every select of a form and submits it, from one decision', async () => {
    document.body.innerHTML = `
      <form aria-label="Preferences">
        ${['First', 'Second', 'Third']
          .map((name) => `<label>${name}<select><option value="x">x</option><option value="y">y</option></select></label>`)
          .join('')}
        <button type="submit">Submit</button>
      </form>`;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', submitted);
    const projector = new SceneProjector({ root: document, emit: () => {}, schedule: (cb) => cb() });
    projector.scan();
    projector.start();

    // the server picks the commit and "y" for every member
    const built = buildActionQuestions(projector.current)!;
    const [playbook] = built.playbooks;
    expect(playbook.members).toHaveLength(3);
    const pick = (label: string) => ({ type: 'choice', choice: label, probabilities: { [label]: 0.9 }, confidence: 0.9 });
    const answers = {
      [ACTION_QUESTION]: pick(Object.keys(built.actions).find((l) => built.actions[l].nodeId === playbook.commit)!),
      [DONE_QUESTION]: { type: 'noul', noul: 0 },
      ...Object.fromEntries(playbook.members.map((m) => [m.decoder.key, pick('y')])),
    };
    const brain = createSystemOneBrain({
      baseURL: 'http://jev.test',
      model: 'test',
      fetchImpl: async () => new Response(JSON.stringify({ model: 'test', answers })),
    });
    const decision = await brain({ scene: projector.current, goal: 'choose y everywhere and submit' });

    applyPlan(decision.actions, { resolve: (id) => projector.elementFor(id), nodeOf: (id) => projector.nodeOf(id) });

    expect([...document.querySelectorAll('select')].map((s) => s.value)).toEqual(['y', 'y', 'y']);
    for (const m of playbook.members) expect((projector.current.nodes[m.nodeId] as StateNode).value).toBe('y');
    expect(submitted).toHaveBeenCalledTimes(1);
    projector.stop();
  });
});
