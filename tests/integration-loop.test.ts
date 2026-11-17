import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatedBrain, createSystemOneBrain } from '../utils/system-one-brain';
import { ACTION_QUESTION, DONE_QUESTION } from '../utils/system-one-questions';
import type { Brain, Decision } from '../utils/brain';
import type { StateNode } from '../utils/scene';
import { click, finished, mount, named, pageSays, set, type Rig } from './fixtures/rig';

let rig: Rig | undefined;
afterEach(() => {
  rig?.stop();
  rig = undefined;
});

const valueOf = (scene: Parameters<typeof named>[0], name: string) => (named(scene, name) as StateNode | undefined)?.value;

describe('the whole loop, closed through the page', () => {
  it('signs in: fills fields, waits for a disabled submit to enable, clicks it, and stops', async () => {
    const html = `
      <form id="f" aria-label="Sign in">
        <label>Email <input id="e" type="text"></label>
        <label>Remember me <input id="r" type="checkbox"></label>
        <button id="go" type="submit" disabled>Sign in</button>
      </form>`;
    // memoryless: every move is derived from what the page shows now
    rig = mount(html, (scene) => {
      if (pageSays(scene, 'Welcome')) return finished;
      const email = named(scene, 'Email')!;
      if ((email as StateNode).value === '') return set(email.id, 'alice@example.com');
      const remember = named(scene, 'Remember me')!;
      if ((remember as StateNode).value === false) return set(remember.id, true);
      return click(named(scene, 'Sign in')!.id);
    });
    const email = document.getElementById('e') as HTMLInputElement;
    const go = document.getElementById('go') as HTMLButtonElement;
    email.addEventListener('input', () => (go.disabled = email.value === ''));
    document.getElementById('f')!.addEventListener('submit', (e) => {
      e.preventDefault();
      document.body.innerHTML = '<p>Welcome back</p>';
    });

    await rig.waitFor(() => rig!.turns.some((t) => t.done), 'the goal to be judged met');
    expect(rig.turns.filter((t) => t.actions.length > 0).map((t) => t.actions[0].kind)).toEqual([
      'setState',
      'setState',
      'clickTrigger',
    ]);
    expect(document.body.textContent).toContain('Welcome back');
  });

  it('never offers a trigger again once it has changed nothing, and reaches the live one', async () => {
    rig = mount('<button id="dead">Dead end</button><button id="live">Live</button>', (scene) => {
      if (pageSays(scene, 'Arrived')) return finished;
      // the first thing it would try is always the dead one, if it is on offer
      const dead = named(scene, 'Dead end');
      return click((dead && !dead.perception.stalled ? dead : named(scene, 'Live')!).id);
    });
    document.getElementById('live')!.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<p>Arrived</p>');
    });

    await rig.waitFor(() => rig!.turns.some((t) => t.done), 'the live button to be reached');
    const clicked = rig.turns.flatMap((t) => t.actions.map((a) => rig!.scene().nodes[a.nodeId.replace('f0.', '')]?.name));
    expect(rig.turns[0].afforded.trigger).toHaveLength(2);
    expect(rig.turns[1].afforded.trigger).toHaveLength(1);
    expect(clicked.filter((n) => n === 'Dead end')).toHaveLength(1);
  });

  it('stops by itself when the only trigger is dead, instead of retrying until the budget', async () => {
    rig = mount('<button>Nothing happens</button>', (scene) => {
      const only = Object.values(scene.nodes).find((n) => n.category === 'action' && !n.perception.stalled);
      return only ? click(only.id) : { decided: false, satisfied: '', remaining: '', actions: [] };
    });
    await rig.quiet(300);
    expect(rig.turns).toHaveLength(2);
    expect(rig.turns[1].actions).toEqual([]);
  });

  it('bounds a page that changes on every action and never converges', async () => {
    rig = mount('<button id="go">Go</button><p id="n">0</p>', (scene) => click(named(scene, 'Go')!.id), { maxTicks: 4 });
    let count = 0;
    document.getElementById('go')!.addEventListener('click', () => {
      document.getElementById('n')!.textContent = String(++count);
    });
    await rig.quiet(300);
    expect(rig.turns).toHaveLength(4);
    expect(count).toBe(4);
  });

  it('gives a navigated-to document a fresh tick budget', async () => {
    const go = (scene: Parameters<typeof named>[0]) => click(named(scene, 'Go')!.id);
    rig = mount('<button id="go">Go</button><p id="n">0</p>', go, { maxTicks: 2 });
    document.getElementById('go')!.addEventListener('click', () => (document.getElementById('n')!.textContent += '+'));
    await rig.quiet(300);
    expect(rig.turns).toHaveLength(2);

    rig.navigate('<button id="go">Go</button><p id="n">fresh</p>');
    document.getElementById('go')!.addEventListener('click', () => (document.getElementById('n')!.textContent += '+'));
    await rig.quiet(300);
    expect(rig.turns).toHaveLength(4);
    expect(new Set(rig.turns.map((t) => t.documentId)).size).toBe(2);
  });

  it('keeps controls behind an open modal out of reach until it closes', async () => {
    rig = mount(
      `<button id="behind">Behind</button>
       <dialog id="d" open aria-modal="true"><button id="ok">OK</button></dialog>`,
      (scene) => {
        const ok = named(scene, 'OK');
        if (ok && !ok.perception.inertByModal) return click(ok.id);
        return finished;
      },
    );
    document.getElementById('ok')!.addEventListener('click', () => document.getElementById('d')!.removeAttribute('open'));
    await rig.waitFor(() => rig!.turns.length >= 2, 'a second decision after the modal closed');
    expect(rig.turns[0].afforded.trigger.map((id) => rig!.scene().nodes[id.replace('f0.', '')]?.name)).toEqual(['OK']);
    expect(rig.turns[1].afforded.trigger.map((id) => rig!.scene().nodes[id.replace('f0.', '')]?.name)).toEqual(['Behind']);
  });
});

describe('System One through the loop', () => {
  const choice = (pick: string, confidence = 0.95) => ({
    type: 'choice' as const,
    choice: pick,
    probabilities: { [pick]: confidence },
    confidence,
  });

  /** answers from the request itself: the commit, "y" for every value, done once the page says so */
  function server(options: { memberConfidence?: number } = {}) {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const { state, questions } = JSON.parse(init.body as string) as {
        state: string;
        questions: Record<string, { criteria?: Record<string, string> }>;
      };
      const answers: Record<string, unknown> = {
        [DONE_QUESTION]: { type: 'noul', noul: state.includes('Saved') ? 0.99 : 0 },
      };
      for (const [key, question] of Object.entries(questions)) {
        if (key === ACTION_QUESTION) {
          const submit = Object.entries(question.criteria!).find(([, why]) => why.includes('Submit'))!;
          answers[key] = choice(submit[0]);
        } else if (key.startsWith('value_of_')) {
          answers[key] = choice('y', options.memberConfidence ?? 0.95);
        }
      }
      return new Response(JSON.stringify({ model: 'test', answers }));
    });
  }

  const form = `
    <form id="f" aria-label="Preferences">
      ${['First', 'Second', 'Third']
        .map((n) => `<label>${n}<select><option value="x">x</option><option value="y">y</option></select></label>`)
        .join('')}
      <button type="submit">Submit</button>
    </form>`;
  const wire = () => {
    const submitted = vi.fn((e: Event) => {
      e.preventDefault();
      document.body.insertAdjacentHTML('beforeend', '<p>Saved</p>');
    });
    document.getElementById('f')!.addEventListener('submit', submitted);
    return submitted;
  };
  const slowStub = (calls: string[]): Brain => async (input) => {
    calls.push('slow');
    const selects = Object.values(input.scene.nodes).filter((n) => n.category === 'state');
    const decision: Decision = {
      decided: true,
      satisfied: '',
      remaining: '',
      actions: [
        ...selects.map((n) => ({ kind: 'setState' as const, nodeId: n.id, value: 'y' })),
        { kind: 'clickTrigger' as const, nodeId: named(input.scene, 'Submit')!.id },
      ],
    };
    return decision;
  };

  it('settles a whole form in one acting tick, then stops on the page saying so', async () => {
    const fetchImpl = server();
    const gated = createGatedBrain({
      fast: createSystemOneBrain({ baseURL: 'http://jev.test', model: 'test', fetchImpl }),
      slow: slowStub([]),
      threshold: 0.6,
    });
    rig = mount(form, (scene) => gated({ scene, goal: 'set everything to y and save' }));
    const submitted = wire();

    await rig.waitFor(() => rig!.turns.some((t) => t.done), 'the goal to be judged met');
    expect(rig.turns.filter((t) => t.actions.length > 0)).toHaveLength(1);
    expect(rig.turns[0].actions.map((a) => a.kind)).toEqual(['setState', 'setState', 'setState', 'clickTrigger']);
    expect(rig.turns[0].via).toBe('system-one');
    expect([...document.querySelectorAll('select')].map((s) => s.value)).toEqual(['y', 'y', 'y']);
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('hands the whole Scene to the slow brain when one member is unsure, submitting nothing from the fast path', async () => {
    const calls: string[] = [];
    const gated = createGatedBrain({
      fast: createSystemOneBrain({ baseURL: 'http://jev.test', model: 'test', fetchImpl: server({ memberConfidence: 0.2 }) }),
      slow: slowStub(calls),
      threshold: 0.6,
    });
    rig = mount(form, (scene) =>
      pageSays(scene, 'Saved') ? Promise.resolve(finished) : gated({ scene, goal: 'set everything to y and save' }),
    );
    const submitted = wire();

    await rig.waitFor(() => submitted.mock.calls.length === 1, 'the form to be submitted');
    expect(calls).toEqual(['slow']);
    expect(rig.turns[0].via).toMatch(/system-one->.*low confidence/);
  });
});
