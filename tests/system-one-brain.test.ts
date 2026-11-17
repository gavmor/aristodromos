import { describe, expect, it, vi } from 'vitest';
import { createGatedBrain, createSystemOneBrain } from '../utils/system-one-brain';
import { ACTION_QUESTION, DONE_QUESTION, valueQuestionKey } from '../utils/system-one-questions';
import type { Brain, Decision } from '../utils/brain';
import type { SystemOneAnswer } from '../utils/system-one';
import { MAX_CHOICE_CRITERIA } from '../utils/system-one';
import { actionNode, loginScene, perception, sceneOf, selectFormScene, selectNode, stateNode } from './fixtures/scene';

const choice = (pick: string, confidence: number): SystemOneAnswer => ({
  type: 'choice',
  choice: pick,
  probabilities: { [pick]: confidence },
  confidence,
});

/** A server that answers exactly what the test says, and records what it was asked. */
function server(answers: Record<string, SystemOneAnswer>) {
  const sent: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ model: 'test', answers }), { status: 200 });
  });
  return { fetchImpl, sent };
}

const brainWith = (answers: Record<string, SystemOneAnswer>, doneThreshold?: number) => {
  const { fetchImpl, sent } = server(answers);
  return {
    sent,
    fetchImpl,
    brain: createSystemOneBrain({ baseURL: 'http://jev.test', model: 'autojev', doneThreshold, fetchImpl }),
  };
};

const ask = (brain: ReturnType<typeof createSystemOneBrain>, scene = loginScene({ submitEnabled: true })) =>
  brain({ scene, goal: 'Sign in as alice@example.com and remember this device.' });

describe('createSystemOneBrain', () => {
  it('emits the chosen trigger in one round trip, carrying the server confidence', async () => {
    const { brain, fetchImpl } = brainWith({
      [ACTION_QUESTION]: choice('click_sign_in', 0.94),
      [DONE_QUESTION]: { type: 'noul', noul: 0.02 },
    });
    const decision = await ask(brain);

    expect(decision.actions).toEqual([{ kind: 'clickTrigger', nodeId: 'n4' }]);
    expect(decision.confidence).toBeCloseTo(0.94);
    expect(decision.via).toBe('system-one');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('answers an enumerable value inside the SAME request, and decodes it', async () => {
    const { brain, sent } = brainWith({
      [ACTION_QUESTION]: choice('toggle_remember_this_device', 0.88),
      [valueQuestionKey('n3')]: choice('yes', 0.91),
      [DONE_QUESTION]: { type: 'noul', noul: 0.01 },
    });
    const decision = await ask(brain);

    expect(decision.actions).toEqual([{ kind: 'setState', nodeId: 'n3', value: true }]);
    // the action and its value were asked together, not in two trips
    const questions = Object.keys((sent[0] as { questions: object }).questions);
    expect(questions).toContain(ACTION_QUESTION);
    expect(questions).toContain(valueQuestionKey('n3'));
  });

  it('takes the MINIMUM of target and value confidence — a sure target is not a sure decision', async () => {
    const { brain } = brainWith({
      [ACTION_QUESTION]: choice('toggle_remember_this_device', 0.99),
      [valueQuestionKey('n3')]: choice('no', 0.41),
      [DONE_QUESTION]: { type: 'noul', noul: 0.01 },
    });
    const decision = await ask(brain);
    expect(decision.confidence).toBeCloseTo(0.41);
    expect(decision.actions).toEqual([{ kind: 'setState', nodeId: 'n3', value: false }]);
  });

  it('flags a free-text target instead of inventing a value', async () => {
    const { brain } = brainWith({
      [ACTION_QUESTION]: choice('fill_email_address', 0.97),
      [DONE_QUESTION]: { type: 'noul', noul: 0.01 },
    });
    const decision = await ask(brain);

    expect(decision.needsValue).toBe('n1');
    expect(decision.actions).toEqual([]);
    expect(decision.decided).toBe(true);
  });

  it('stops on the noul, which is the only thing that can end the loop', async () => {
    const { brain } = brainWith(
      { [ACTION_QUESTION]: choice('click_sign_in', 0.99), [DONE_QUESTION]: { type: 'noul', noul: 0.9 } },
      0.75,
    );
    const decision = await ask(brain);
    expect(decision.actions).toEqual([]);
    expect(decision.decided).toBe(true);
    expect(decision.confidence).toBeCloseTo(0.9);
  });

  it('keeps going when the noul is below the stop threshold', async () => {
    const { brain } = brainWith(
      { [ACTION_QUESTION]: choice('click_sign_in', 0.99), [DONE_QUESTION]: { type: 'noul', noul: 0.74 } },
      0.75,
    );
    expect((await ask(brain)).actions).toEqual([{ kind: 'clickTrigger', nodeId: 'n4' }]);
  });

  it('reports "nothing afforded" without calling the server', async () => {
    const { brain, fetchImpl } = brainWith({});
    const decision = await ask(brain, sceneOf());
    expect(decision.decided).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a label that was never offered', async () => {
    const { brain } = brainWith({
      [ACTION_QUESTION]: choice('click_delete_everything', 0.99),
      [DONE_QUESTION]: { type: 'noul', noul: 0.01 },
    });
    await expect(ask(brain)).rejects.toThrow(/was not offered/);
  });

  it('refuses a scene it cannot NAME in full rather than silently dropping options', async () => {
    const { brain, fetchImpl } = brainWith({});
    const crowded = sceneOf(
      ...Array.from({ length: MAX_CHOICE_CRITERIA + 1 }, (_, i) => stateNode({ id: `n${i}`, name: `Field ${i}` })),
    );
    await expect(ask(brain, crowded)).rejects.toThrow(/over the 255-criteria choice limit/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves a scene exactly at the limit', async () => {
    const atLimit = sceneOf(
      ...Array.from({ length: MAX_CHOICE_CRITERIA }, (_, i) => stateNode({ id: `n${i}`, name: `Field ${i}` })),
    );
    const { brain } = brainWith({
      [ACTION_QUESTION]: choice('fill_field_0', 0.8),
      [DONE_QUESTION]: { type: 'noul', noul: 0.01 },
    });
    expect((await ask(brain, atLimit)).needsValue).toBe('n0');
  });
});

const slowBrain = (over: Partial<Decision> = {}) =>
  vi.fn<Brain>(async () => ({
    decided: true,
    via: 'ai-sdk',
    satisfied: '',
    remaining: '',
    actions: [{ kind: 'setState', nodeId: 'n1', value: 'alice@example.com' }],
    ...over,
  }));

describe('createGatedBrain', () => {
  it('emits a confident System-One decision without touching the big model', async () => {
    const { brain: fast } = brainWith({
      [ACTION_QUESTION]: choice('click_sign_in', 0.94),
      [DONE_QUESTION]: { type: 'noul', noul: 0.01 },
    });
    const slow = slowBrain();
    const decision = await createGatedBrain({ fast, slow, threshold: 0.6 })({
      scene: loginScene({ submitEnabled: true }),
      goal: 'sign in',
    });

    expect(decision.via).toBe('system-one');
    expect(slow).not.toHaveBeenCalled();
  });

  it('hands a low-confidence decision to the big model, recording the measurement', async () => {
    const { brain: fast } = brainWith({
      [ACTION_QUESTION]: choice('click_sign_in', 0.31),
      [DONE_QUESTION]: { type: 'noul', noul: 0.01 },
    });
    const slow = slowBrain();
    const decision = await createGatedBrain({ fast, slow, threshold: 0.6 })({
      scene: loginScene({ submitEnabled: true }),
      goal: 'sign in',
    });

    expect(slow).toHaveBeenCalledTimes(1);
    expect(decision.via).toBe('system-one->ai-sdk (low confidence)');
    expect(decision.confidence).toBeCloseTo(0.31);
    expect(decision.actions).toEqual([{ kind: 'setState', nodeId: 'n1', value: 'alice@example.com' }]);
  });

  it('hands over for a free-text value even when System-One is certain of the target', async () => {
    const { brain: fast } = brainWith({
      [ACTION_QUESTION]: choice('fill_email_address', 0.99),
      [DONE_QUESTION]: { type: 'noul', noul: 0.01 },
    });
    const slow = slowBrain();
    const decision = await createGatedBrain({ fast, slow, threshold: 0.6 })({
      scene: loginScene({ submitEnabled: true }),
      goal: 'sign in',
    });

    expect(slow).toHaveBeenCalledTimes(1);
    expect(decision.via).toBe('system-one->ai-sdk (needs a value for n1)');
  });

  it('an unreachable System-One must not stop the agent — it falls through, reason recorded', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const fast = createSystemOneBrain({ baseURL: 'http://jev.test', model: 'autojev', fetchImpl });
    const slow = slowBrain();
    const decision = await createGatedBrain({ fast, slow, threshold: 0.6 })({
      scene: loginScene({ submitEnabled: true }),
      goal: 'sign in',
    });

    expect(slow).toHaveBeenCalledTimes(1);
    expect(decision.via).toContain('system-one failed: ECONNREFUSED');
  });

  it('does not ask the big model to re-litigate an empty option set', async () => {
    const { brain: fast } = brainWith({});
    const slow = slowBrain();
    const decision = await createGatedBrain({ fast, slow, threshold: 0.6 })({ scene: sceneOf(), goal: 'sign in' });

    expect(decision.decided).toBe(false);
    expect(slow).not.toHaveBeenCalled();
  });
});

describe('playbooks', () => {
  const memberAnswers = (confidences: [number, number, number] = [0.9, 0.8, 0.95]) => ({
    [valueQuestionKey('s1')]: choice('b', confidences[0]),
    [valueQuestionKey('s2')]: choice('d', confidences[1]),
    [valueQuestionKey('s3')]: choice('e', confidences[2]),
    [DONE_QUESTION]: { type: 'noul', noul: 0.01 } as SystemOneAnswer,
  });
  const batch = [
    { kind: 'setState', nodeId: 's1', value: 'b' },
    { kind: 'setState', nodeId: 's2', value: 'd' },
    { kind: 'setState', nodeId: 's3', value: 'e' },
    { kind: 'clickTrigger', nodeId: 'b1' },
  ];
  const askForm = (brain: ReturnType<typeof createSystemOneBrain>, scene = selectFormScene()) =>
    brain({ scene, goal: 'Fill in the form and submit it.' });

  it('emits every member then the commit in one tick, at the minimum confidence', async () => {
    const { brain, fetchImpl } = brainWith({ [ACTION_QUESTION]: choice('click_submit', 0.97), ...memberAnswers() });
    const decision = await askForm(brain);

    expect(decision.actions).toEqual(batch);
    expect(decision.confidence).toBeCloseTo(0.8);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('expands a pick of any member to the same batch', async () => {
    const { brain } = brainWith({ [ACTION_QUESTION]: choice('choose_second', 0.7), ...memberAnswers() });
    const decision = await askForm(brain);
    expect(decision.actions).toEqual(batch);
    expect(decision.confidence).toBeCloseTo(0.7);
  });

  it('sends the whole Scene to the slow brain when one member is unsure — never half a batch', async () => {
    const { brain: fast } = brainWith({
      [ACTION_QUESTION]: choice('click_submit', 0.97),
      ...memberAnswers([0.9, 0.3, 0.95]),
    });
    const slow = slowBrain();
    const decision = await createGatedBrain({ fast, slow, threshold: 0.6 })({
      scene: selectFormScene(),
      goal: 'Fill in the form and submit it.',
    });

    expect(slow).toHaveBeenCalledTimes(1);
    expect(decision.via).toBe('system-one->ai-sdk (low confidence)');
    expect(decision.confidence).toBeCloseTo(0.3);
  });

  it('drops back to the single action when a member answer is missing', async () => {
    const { [valueQuestionKey('s3')]: _missing, ...answers } = memberAnswers();
    const { brain } = brainWith({ [ACTION_QUESTION]: choice('choose_first', 0.9), ...answers });
    const decision = await askForm(brain);
    expect(decision.actions).toEqual([{ kind: 'setState', nodeId: 's1', value: 'b' }]);
  });

  it('never submits bare: a picked commit with an undecodable member goes to the slow brain', async () => {
    const answers = { ...memberAnswers(), [valueQuestionKey('s2')]: choice('not_offered', 0.99) };
    const { brain: fast } = brainWith({ [ACTION_QUESTION]: choice('click_submit', 0.97), ...answers });
    const slow = slowBrain();
    const decision = await createGatedBrain({ fast, slow, threshold: 0.6 })({
      scene: selectFormScene(),
      goal: 'Fill in the form and submit it.',
    });

    expect(slow).toHaveBeenCalledTimes(1);
    expect(decision.via).toBe('system-one->ai-sdk (low confidence)');
    expect(decision.confidence).toBe(0);
  });

  it('keeps the needsValue path when a free-text field shares the scope', async () => {
    const scene = selectFormScene({}, stateNode({ id: 't1', name: 'Notes', relations: { container: 'f1' } }));
    const { brain } = brainWith({ [ACTION_QUESTION]: choice('fill_notes', 0.95), ...memberAnswers() });
    const decision = await askForm(brain, scene);
    expect(decision.needsValue).toBe('t1');
    expect(decision.actions).toEqual([]);
  });

  it('is exactly the single-action decision without a playbook', async () => {
    const commit = actionNode({ id: 'b1', name: 'Submit', action: 'submit', relations: { container: 'f1' } });
    const lone = sceneOf(selectNode('s1', 'First', 'f1', ['a', 'b']), commit);
    const twoCommits = selectFormScene({}, { ...commit, id: 'b2', name: 'Submit later' });
    const stalled = selectFormScene({ submit: { perception: perception({ stalled: true }) } });
    const { brain } = brainWith({ [ACTION_QUESTION]: choice('choose_first', 0.9), ...memberAnswers() });

    for (const scene of [lone, twoCommits, stalled]) {
      expect(await askForm(brain, scene)).toEqual({
        decided: true,
        via: 'system-one',
        satisfied: '',
        remaining: '',
        confidence: 0.9,
        actions: [{ kind: 'setState', nodeId: 's1', value: 'b' }],
      });
    }
  });
});
