import { describe, expect, it } from 'vitest';
import {
  ACTION_QUESTION,
  DONE_QUESTION,
  buildActionQuestions,
  buildPlaybooks,
  describeState,
  valueQuestionKey,
} from '../utils/system-one-questions';
import {
  actionNode,
  loginScene,
  perception,
  sceneOf,
  selectFormScene,
  selectNode,
  stateNode,
  structureNode,
} from './fixtures/scene';
import type { SystemOneQuestion } from '../utils/system-one';

const choiceOf = (questions: Record<string, SystemOneQuestion>, key: string) => {
  const question = questions[key];
  if (!question || question.type !== 'choice') throw new Error(`expected a choice at ${key}`);
  return question;
};

describe('buildActionQuestions', () => {
  it('returns null when the scene affords nothing nameable', () => {
    expect(buildActionQuestions(sceneOf())).toBeNull();
  });

  it('names every legal (verb, node) pair once, using the accessible name', () => {
    const built = buildActionQuestions(loginScene({ submitEnabled: true }))!;
    expect(Object.keys(choiceOf(built.questions, ACTION_QUESTION).criteria).sort()).toEqual([
      'click_sign_in',
      'fill_email_address',
      'fill_password',
      'toggle_remember_this_device',
    ]);
    expect(built.actions.click_sign_in).toEqual({ kind: 'clickTrigger', nodeId: 'n4' });
    expect(built.actions.fill_email_address).toEqual({ kind: 'setState', nodeId: 'n1' });
  });

  it('makes an illegal verb/node pair UNNAMEABLE: no label reaches the other verb a node', () => {
    const built = buildActionQuestions(loginScene({ submitEnabled: true }))!;
    const targets = Object.values(built.actions);
    // The state ids are only ever reachable as setState, the trigger id only as
    // clickTrigger — the discriminated union, enforced by the label set.
    expect(targets.filter((t) => t.kind === 'clickTrigger').map((t) => t.nodeId)).toEqual(['n4']);
    expect(targets.filter((t) => t.kind === 'setState').map((t) => t.nodeId).sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('withholds a disabled trigger entirely — it cannot be chosen at any probability', () => {
    const built = buildActionQuestions(loginScene({ submitEnabled: false }))!;
    expect(Object.keys(choiceOf(built.questions, ACTION_QUESTION).criteria)).not.toContain('click_sign_in');
    expect(Object.values(built.actions).some((t) => t.kind === 'clickTrigger')).toBe(false);
  });

  it('drops modal-inert and read-only nodes too', () => {
    const built = buildActionQuestions(
      sceneOf(
        stateNode({ id: 'n1', name: 'Live' }),
        stateNode({ id: 'n2', name: 'Behind', perception: perception({ inertByModal: true }) }),
        stateNode({ id: 'n3', name: 'Fixed', readOnly: true }),
        actionNode({ id: 'n4', name: 'Go' }),
      ),
    )!;
    expect(Object.values(built.actions).map((t) => t.nodeId).sort()).toEqual(['n1', 'n4']);
  });

  it('asks a value question for enumerable controls only, and decodes its labels', () => {
    const built = buildActionQuestions(
      sceneOf(
        stateNode({ id: 'n1', name: 'Email address' }),
        stateNode({ id: 'n2', name: 'Remember me', control: 'boolean', value: false }),
        stateNode({
          id: 'n3',
          name: 'Country',
          control: 'option',
          value: 'us',
          options: [
            { value: 'us', label: 'United States' },
            { value: 'fr', label: 'France' },
          ],
        }),
        stateNode({ id: 'n4', name: 'Volume', control: 'range', value: 3, min: 0, max: 10 }),
      ),
    )!;

    // free text and an unbounded-ish number are NOT askable of a label classifier
    expect(built.values.n1).toBeUndefined();
    expect(built.values.n4).toBeUndefined();

    expect(built.values.n2).toEqual({ key: valueQuestionKey('n2'), labels: { yes: true, no: false } });
    expect(built.values.n3.labels).toEqual({ united_states: 'us', france: 'fr' });
    expect(Object.keys(choiceOf(built.questions, valueQuestionKey('n3')).criteria).sort()).toEqual([
      'france',
      'united_states',
    ]);
    expect(built.questions[valueQuestionKey('n1')]).toBeUndefined();
  });

  it('always carries the noul that is the loop s only stop condition', () => {
    const built = buildActionQuestions(loginScene())!;
    expect(built.questions[DONE_QUESTION]).toMatchObject({ type: 'noul' });
  });

  it('disambiguates two controls with the same accessible name', () => {
    const built = buildActionQuestions(
      sceneOf(stateNode({ id: 'n1', name: 'Amount' }), stateNode({ id: 'n2', name: 'Amount' })),
    )!;
    expect(built.actions.fill_amount).toEqual({ kind: 'setState', nodeId: 'n1' });
    expect(built.actions.fill_amount_2).toEqual({ kind: 'setState', nodeId: 'n2' });
  });

  it('falls back to the role when a node has no accessible name', () => {
    const built = buildActionQuestions(sceneOf(stateNode({ id: 'n1' })))!;
    expect(built.actions.fill_the_textbox).toEqual({ kind: 'setState', nodeId: 'n1' });
  });

  it('describes current values in the criteria, so a done control is visibly done', () => {
    const built = buildActionQuestions(loginScene({ submitEnabled: true, email: 'alice@example.com' }))!;
    expect(choiceOf(built.questions, ACTION_QUESTION).criteria.fill_email_address).toContain('alice@example.com');
  });
});

describe('buildPlaybooks', () => {
  it('finds K enumerable controls and the one submit sharing a scope', () => {
    const [playbook, ...rest] = buildPlaybooks(selectFormScene());
    expect(rest).toEqual([]);
    expect(playbook.scope).toBe('f1');
    expect(playbook.commit).toBe('b1');
    expect(playbook.members.map((m) => m.nodeId)).toEqual(['s1', 's2', 's3']);
    // each member reuses the value question's own key and decoder
    expect(playbook.members[0].decoder).toEqual({ key: valueQuestionKey('s1'), labels: { a: 'a', b: 'b' } });
  });

  it('keeps the control and its scope in every criterion, and is what the request carries', () => {
    const built = buildActionQuestions(selectFormScene())!;
    const [playbook] = built.playbooks;
    const second = playbook.members[1];
    expect(second.question.criteria.d).toBe('Set Second in Preferences to d.');
    expect(built.questions[second.decoder.key]).toEqual(second.question);
    expect(built.values.s2).toEqual(second.decoder);
  });

  it('accepts a single plain trigger as the commit when there is no submit', () => {
    const scene = selectFormScene({ submit: { action: 'click' } });
    expect(buildPlaybooks(scene).map((p) => p.commit)).toEqual(['b1']);
  });

  it('prefers the submit over other triggers in the scope', () => {
    const scene = selectFormScene({}, actionNode({ id: 'b2', name: 'Reset', relations: { container: 'f1' } }));
    expect(buildPlaybooks(scene).map((p) => p.commit)).toEqual(['b1']);
  });

  it('offers nothing when a free-text field shares the scope', () => {
    const scene = selectFormScene({}, stateNode({ id: 't1', name: 'Notes', relations: { container: 'f1' } }));
    expect(buildPlaybooks(scene)).toEqual([]);
  });

  it('offers nothing when two triggers could commit', () => {
    const twoSubmits = selectFormScene(
      {},
      actionNode({ id: 'b2', name: 'Submit later', action: 'submit', relations: { container: 'f1' } }),
    );
    const twoClicks = selectFormScene(
      { submit: { action: 'click' } },
      actionNode({ id: 'b2', name: 'Other', relations: { container: 'f1' } }),
    );
    expect(buildPlaybooks(twoSubmits)).toEqual([]);
    expect(buildPlaybooks(twoClicks)).toEqual([]);
  });

  it('offers nothing for a lone select', () => {
    const scene = sceneOf(
      structureNode({ id: 'f1' }),
      selectNode('s1', 'First', 'f1', ['a', 'b']),
      actionNode({ id: 'b1', name: 'Submit', action: 'submit', relations: { container: 'f1' } }),
    );
    expect(buildPlaybooks(scene)).toEqual([]);
  });

  it('offers nothing when the commit is stalled, disabled or hidden', () => {
    for (const p of [{ stalled: true }, { disabled: true }, { visible: false }]) {
      expect(buildPlaybooks(selectFormScene({ submit: { perception: perception(p) } }))).toEqual([]);
    }
  });

  it('ignores an unreachable member rather than counting it', () => {
    const scene = selectFormScene(
      {},
      stateNode({ id: 't1', name: 'Notes', relations: { container: 'f1' }, perception: perception({ disabled: true }) }),
    );
    expect(buildPlaybooks(scene).map((p) => p.members.length)).toEqual([3]);
  });

  it('offers nothing for nested scopes, inner or outer', () => {
    const scene = selectFormScene(
      {},
      structureNode({ id: 'g1', role: 'group', landmark: 'group', relations: { container: 'f1' } }),
      selectNode('s4', 'Fourth', 'g1', ['g', 'h']),
      selectNode('s5', 'Fifth', 'g1', ['i', 'j']),
      actionNode({ id: 'b2', name: 'Apply', relations: { container: 'g1' } }),
    );
    expect(buildPlaybooks(scene)).toEqual([]);
  });

  it('lets a nested scope of triggers only stand beside the batch', () => {
    const scene = selectFormScene(
      {},
      structureNode({ id: 'l1', role: 'list', landmark: 'list', relations: { container: 'f1' } }),
      actionNode({ id: 'a1', name: 'Elsewhere', action: 'navigate', href: '/x', relations: { container: 'l1' } }),
    );
    expect(buildPlaybooks(scene).map((p) => p.scope)).toEqual(['f1']);
  });

  it('grounds a member in its current value even when its scope is not in the Scene', () => {
    const { f1: _scope, ...nodes } = selectFormScene().nodes;
    const [playbook] = buildPlaybooks({ ...selectFormScene(), nodes });
    expect(playbook.members[0].question.instructions).toBe(
      'What should First hold (currently "a")? Keep it if it is already right.',
    );
    expect(playbook.members[0].question.criteria.b).toBe('Set First to b.');
  });

  it('falls back to the outline parent when no container is declared', () => {
    const unscoped = (id: string, name: string) => ({ ...selectNode(id, name, '', ['a', 'b']), relations: {}, parent: 'p1' });
    const scene = sceneOf(
      unscoped('s1', 'First'),
      unscoped('s2', 'Second'),
      actionNode({ id: 'b1', name: 'Go', parent: 'p1' }),
    );
    expect(buildPlaybooks(scene).map((p) => p.scope)).toEqual(['p1']);
  });
});

describe('describeState', () => {
  it('is the goal plus the same Scene serialization the AI SDK brain reads', () => {
    const state = describeState(loginScene(), 'Sign in as alice@example.com');
    expect(state).toContain('goal: Sign in as alice@example.com');
    expect(state).toContain('Email address');
    // disabled nodes stay DESCRIBED even though they are not nameable as options
    expect(state).toContain('[disabled]');
  });
});
