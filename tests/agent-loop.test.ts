import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../utils/agent-loop';
import { SceneStore } from '../utils/scene-store';
import type { Decision } from '../utils/brain';
import type { Perception, Scene, SceneNode, StateNode } from '../utils/scene';
import type { DownMessage, TurnRecord } from '../utils/wire';

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
  reasoning: 'fill it',
  actions: [{ kind: 'setState', nodeId, value }],
});
const done: Decision = { decided: true, reasoning: 'nothing left', actions: [] };

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
      { kind: 'plan', documentId: 'd1', tick: 1, reasoning: 'fill it', actions: [{ kind: 'setState', nodeId: 'email', value: 'a@b.c' }] },
    ]);
    vi.useRealTimers();
  });

  it('sends idle, not a plan, when the goal is already satisfied', async () => {
    vi.useFakeTimers();
    const { loop, sent } = harness([done]);
    loop.ingest({ kind: 'snapshot', scene: sceneWith('d1', field('email')) });
    await vi.advanceTimersByTimeAsync(20);
    expect(sent[0].kind).toBe('idle');
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
});
