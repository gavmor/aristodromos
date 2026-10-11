import { describe, expect, it } from 'vitest';
import {
  ACTION_QUESTION,
  DONE_QUESTION,
  buildActionQuestions,
  describeState,
  valueQuestionKey,
} from '../utils/system-one-questions';
import { actionNode, loginScene, perception, sceneOf, stateNode } from './fixtures/scene';
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

describe('describeState', () => {
  it('is the goal plus the same Scene serialization the AI SDK brain reads', () => {
    const state = describeState(loginScene(), 'Sign in as alice@example.com');
    expect(state).toContain('goal: Sign in as alice@example.com');
    expect(state).toContain('Email address');
    // disabled nodes stay DESCRIBED even though they are not nameable as options
    expect(state).toContain('[disabled]');
  });
});
