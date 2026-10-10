import { describe, expect, it, vi } from 'vitest';
import { createGatedBrain, createSystemOneBrain } from '../utils/system-one-brain';
import { ACTION_QUESTION, DONE_QUESTION, valueQuestionKey } from '../utils/system-one-questions';
import type { Brain, Decision } from '../utils/brain';
import type { SystemOneAnswer } from '../utils/system-one';
import { loginScene, sceneOf } from './fixtures/scene';

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
