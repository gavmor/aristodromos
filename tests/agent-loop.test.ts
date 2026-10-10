import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../utils/agent-loop';
import { SceneStore } from '../utils/scene-store';
import type { Decision } from '../utils/brain';
import type { Perception, Scene, SceneNode, StateNode } from '../utils/scene';
import type { DownMessage, PendingDecision, TurnRecord } from '../utils/wire';

const perception: Perception = {
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
};

const field = (id: string, value = ''): StateNode => ({
  id,
  role: 'textbox',
  category: 'state',
  control: 'text',
  value,
  relations: {},
  perception,
  actuation: { setStrategy: 'react-setter' },
});

const sceneWith = (documentId: string, ...nodes: SceneNode[]): Scene => ({
  documentId,
  url: 'https://example.test/',
  title: 'test',
  viewport: { w: 800, h: 600, scrollX: 0, scrollY: 0 },
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
});

describe('SceneStore', () => {
  it('folds snapshot then patches into the same scene', () => {
    const store = new SceneStore();
    store.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    const after = store.ingest({
      kind: 'patch',
      documentId: 'd1',
      ops: [{ op: 'replace', path: '/nodes/email/value', value: 'alice@example.com' }],
    });
    expect((after!.nodes.email as StateNode).value).toBe('alice@example.com');
  });

  it('drops a patch for a document it does not hold', () => {
    const store = new SceneStore();
    store.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    const after = store.ingest({
      kind: 'patch',
      documentId: 'd2',
      ops: [{ op: 'remove', path: '/nodes/email' }],
    });
    expect(after).toBeNull();
    expect(store.current!.nodes.email).toBeDefined();
  });

  it('replaces the whole scene on a new snapshot', () => {
    const store = new SceneStore();
    store.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    store.ingest({ kind: 'snapshot', scene: sceneWith('d2', field('search')) });
    expect(store.current!.documentId).toBe('d2');
    expect(store.current!.nodes.email).toBeUndefined();
  });
});

interface Harness {
  loop: AgentLoop;
  sent: DownMessage[];
  turns: TurnRecord[];
  decide: ReturnType<typeof vi.fn>;
}

function harness(decisions: Decision[], overrides = {}): Harness {
  const sent: DownMessage[] = [];
  const turns: TurnRecord[] = [];
  let i = 0;
  const decide = vi.fn(async () => decisions[Math.min(i++, decisions.length - 1)]);
  const loop = new AgentLoop({
    decide,
    send: (m) => sent.push(m),
    record: (t) => turns.push(t),
    settleMs: 10,
    ...overrides,
  });
  return { loop, sent, turns, decide };
}

const act = (nodeId: string, value: string): Decision => ({
  decided: true,
  satisfied: 'nothing yet',
  remaining: 'fill it',
  actions: [{ kind: 'setState', nodeId, value }],
});
const done: Decision = { decided: true, done: true, satisfied: 'all of it', remaining: '', actions: [] };

describe('AgentLoop', () => {
  it('waits for the scene to settle, then decides exactly once', async () => {
    vi.useFakeTimers();
    const { loop, sent, decide } = harness([act('email', 'a@b.c')]);

    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(5);
    loop.ingest({ kind: 'patch', documentId: 'd1', ops: [{ op: 'replace', path: '/nodes/email/value', value: 'x' }] });
    await vi.advanceTimersByTimeAsync(5);
    expect(decide).not.toHaveBeenCalled(); // still churning

    await vi.advanceTimersByTimeAsync(10);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      { kind: 'plan', documentId: 'd1', tick: 1, satisfied: 'nothing yet', remaining: 'fill it', actions: [{ kind: 'setState', nodeId: 'email', value: 'a@b.c' }] },
    ]);
    vi.useRealTimers();
  });

  it('sends idle, not a plan, when the brain judges the goal met, and logs it as done', async () => {
    vi.useFakeTimers();
    const { loop, sent, turns } = harness([done]);
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(20);
    expect(sent[0]).toMatchObject({ kind: 'idle', reason: 'goal met' });
    expect(turns[0].done).toBe(true);
    vi.useRealTimers();
  });

  it('stops deciding once the page stops producing patches', async () => {
    vi.useFakeTimers();
    const { loop, decide } = harness([done]);
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(decide).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('bounds a self-churning page with the tick budget', async () => {
    vi.useFakeTimers();
    const { loop, sent, decide } = harness([act('email', 'a@b.c')], { maxTicks: 3 });
    for (let i = 0; i < 10; i += 1) {
      loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email', `v${i}`)) });
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(decide).toHaveBeenCalledTimes(3);
    expect(sent.at(-1)).toMatchObject({ kind: 'idle', reason: 'tick budget exhausted' });
    vi.useRealTimers();
  });

  it('records a turn even when the brain throws, and reports the error as idle', async () => {
    vi.useFakeTimers();
    const sent: DownMessage[] = [];
    const turns: TurnRecord[] = [];
    const loop = new AgentLoop({
      decide: async () => {
        throw new Error('ollama unreachable');
      },
      send: (m) => sent.push(m),
      record: (t) => turns.push(t),
      settleMs: 10,
    });
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(20);

    expect(turns[0].error).toBe('ollama unreachable');
    expect(sent[0]).toMatchObject({ kind: 'idle', reason: 'ollama unreachable' });
    vi.useRealTimers();
  });

  it('records what the schema afforded, so a run log explains each decision', async () => {
    vi.useFakeTimers();
    const { loop, turns } = harness([act('email', 'a@b.c')]);
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(20);
    expect(turns[0].afforded).toEqual({ state: ['email'], trigger: [] });
    expect(turns[0].actions).toHaveLength(1);
    vi.useRealTimers();
  });

  it('does not decide while paused', async () => {
    vi.useFakeTimers();
    const { loop, decide } = harness([act('email', 'a@b.c')]);
    loop.setPaused(true);
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(50);
    expect(decide).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('decides nothing more after stop()', async () => {
    vi.useFakeTimers();
    const { loop, decide } = harness([act('email', 'a@b.c')]);
    loop.stop();
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(50);
    expect(decide).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('decides on the scene in hand when resumed, without waiting for the page to move', async () => {
    vi.useFakeTimers();
    const { loop, decide } = harness([act('email', 'a@b.c')]);
    loop.setPaused(true);
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(50);

    loop.setPaused(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(decide).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('gives a retargeted loop a fresh budget, deciding on the latest scene', async () => {
    vi.useFakeTimers();
    const { loop, sent, decide } = harness([act('email', 'a@b.c')], { maxTicks: 2 });
    for (let i = 0; i < 4; i += 1) {
      loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email', `v${i}`)) });
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(sent.at(-1)).toMatchObject({ kind: 'idle', reason: 'tick budget exhausted' });
    // the page keeps moving while exhausted; the replica must keep up
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email', 'latest')) });
    await vi.advanceTimersByTimeAsync(20);
    expect(decide).toHaveBeenCalledTimes(2);

    loop.retarget();
    await vi.advanceTimersByTimeAsync(20);
    expect(decide).toHaveBeenCalledTimes(3);
    const scene = decide.mock.calls[2][0] as Scene;
    expect((scene.nodes.email as StateNode).value).toBe('latest');
    expect(sent.at(-1)).toMatchObject({ kind: 'plan', tick: 1 });
    vi.useRealTimers();
  });

  it('retargets a paused loop without deciding until it is resumed', async () => {
    vi.useFakeTimers();
    const { loop, decide } = harness([act('email', 'a@b.c')]);
    loop.setPaused(true);
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    loop.retarget();
    await vi.advanceTimersByTimeAsync(50);
    expect(decide).not.toHaveBeenCalled();

    loop.setPaused(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(decide).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('stays stopped through a retarget and a resume', async () => {
    vi.useFakeTimers();
    const { loop, decide } = harness([act('email', 'a@b.c')]);
    loop.setPaused(true);
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    loop.stop();
    loop.retarget();
    loop.setPaused(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(decide).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reports the decision as pending until the brain answers', async () => {
    vi.useFakeTimers();
    const answer = Promise.withResolvers<Decision>();
    const pending: (PendingDecision | undefined)[] = [];
    const loop = new AgentLoop({
      decide: () => answer.promise,
      send: () => {},
      record: () => {},
      pending: (decision) => pending.push(decision),
      settleMs: 10,
      now: () => 1000,
    });
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(20);
    expect(pending).toEqual([{ tick: 1, startedAt: 1000, documentId: 'd1', url: 'https://example.test/' }]);

    answer.resolve(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.at(-1)).toBeUndefined();
    expect(pending).toHaveLength(2);
    vi.useRealTimers();
  });

  it('clears the pending decision when the brain throws', async () => {
    vi.useFakeTimers();
    const pending: (PendingDecision | undefined)[] = [];
    const loop = new AgentLoop({
      decide: async () => {
        throw new Error('ollama unreachable');
      },
      send: () => {},
      record: () => {},
      pending: (decision) => pending.push(decision),
      settleMs: 10,
    });
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(20);
    expect(pending).toHaveLength(2);
    expect(pending.at(-1)).toBeUndefined();
    vi.useRealTimers();
  });

  it('sends nothing to a page that disconnected while the brain was thinking', async () => {
    vi.useFakeTimers();
    const answer = Promise.withResolvers<Decision>();
    const sent: DownMessage[] = [];
    const pending: (PendingDecision | undefined)[] = [];
    const loop = new AgentLoop({
      decide: () => answer.promise,
      send: (m) => sent.push(m),
      record: () => {},
      pending: (decision) => pending.push(decision),
      settleMs: 10,
    });
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(20);

    loop.stop();
    answer.resolve(act('email', 'a@b.c'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    expect(pending.at(-1)).toBeUndefined(); // the spinner still clears
    vi.useRealTimers();
  });

  it('replicates a settled snapshot without deciding, until the page moves', async () => {
    vi.useFakeTimers();
    const { loop, decide } = harness([act('email', 'a@b.c')]);
    // a fresh worker after eviction, told the old one went idle on this exact Scene
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')), settled: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(decide).not.toHaveBeenCalled();

    loop.ingest({ kind: 'patch', documentId: 'd1', ops: [{ op: 'replace', path: '/nodes/email/value', value: 'x' }] });
    await vi.advanceTimersByTimeAsync(20);
    expect(decide).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not decide an idle scene again on resume, but does on retarget', async () => {
    vi.useFakeTimers();
    const { loop, decide } = harness([done]);
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(20);
    expect(decide).toHaveBeenCalledTimes(1);

    loop.setPaused(true);
    loop.setPaused(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(decide).toHaveBeenCalledTimes(1);

    loop.retarget(); // a new goal, or "Decide now"
    await vi.advanceTimersByTimeAsync(20);
    expect(decide).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('decides again when the page moved while an idle answer was being thought up', async () => {
    vi.useFakeTimers();
    const answer = Promise.withResolvers<Decision>();
    const decide = vi.fn().mockReturnValueOnce(answer.promise).mockResolvedValue(done);
    const loop = new AgentLoop({ decide, send: () => {}, record: () => {}, settleMs: 10 });
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(20);

    loop.ingest({ kind: 'patch', documentId: 'd1', ops: [{ op: 'replace', path: '/nodes/email/value', value: 'x' }] });
    answer.resolve(done); // judged on the scene before the patch
    await vi.advanceTimersByTimeAsync(50);
    expect(decide).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
