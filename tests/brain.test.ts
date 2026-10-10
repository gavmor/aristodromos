import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { decide, describeScene } from '../utils/brain';
import type { ActionNode, ContentNode, Perception, Scene, SceneNode } from '../utils/scene';

const perception: Perception = {
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
};

const paragraph = (id: string, text: string): ContentNode => ({
  id,
  role: 'paragraph',
  category: 'content',
  text,
  relations: {},
  perception,
});

const choice = (id: string, name: string): ActionNode => ({
  id,
  role: 'link',
  name,
  category: 'action',
  action: 'navigate',
  relations: {},
  perception,
  actuation: { fireStrategy: 'pointer-sequence' },
});

const sceneOf = (...nodes: SceneNode[]): Scene => ({
  documentId: 'd1',
  url: 'https://example.test/',
  title: 'story',
  viewport: { w: 800, h: 600, scrollX: 0, scrollY: 0 },
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
});

/** A model that answers every call with this JSON text. */
const answering = (json: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(json) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
  });

describe('describeScene', () => {
  it('gives the model whole paragraphs, not their first line', () => {
    const passage = `You wake in a tunnel. ${'The dark presses in. '.repeat(20)}A groan comes from the wreckage.`;
    const text = describeScene(sceneOf(paragraph('p1', passage), choice('c1', 'Call out')));
    expect(text).toContain(JSON.stringify(passage));
  });

  it('bounds page text by one overall budget and says what it left out', () => {
    const block = 'x'.repeat(2500);
    const text = describeScene(sceneOf(paragraph('p1', block), paragraph('p2', block), paragraph('p3', block), paragraph('p4', block)));
    expect(text).toContain(JSON.stringify(block)); // the first two fit whole
    expect(text).toContain(JSON.stringify(`${'x'.repeat(1000)}…`)); // the third is cut at the budget
    expect(text).toContain('(1 more text blocks omitted)');
  });

  it('spends the text budget on what is on screen first', () => {
    const offscreen = (id: string): ContentNode => ({ ...paragraph(id, 'c'.repeat(3000)), perception: { ...perception, inViewport: false } });
    const story = 'You wake in a tunnel.';
    // Page order puts a store page's comments first; the game's passage is on screen.
    const text = describeScene(sceneOf(offscreen('f0.p1'), offscreen('f0.p2'), offscreen('f0.p3'), paragraph('f14.p1', story)));
    expect(text).toContain(JSON.stringify(story));
    expect(text.indexOf(story)).toBeLessThan(text.indexOf('ccc'));
  });

  it('lists on-screen triggers before the page around them', () => {
    const offscreenLink = { ...choice('f0.n167', 'Community'), perception: { ...perception, inViewport: false } };
    const text = describeScene(sceneOf(offscreenLink, choice('f4.n29', 'Begin the story')));
    expect(text.indexOf('f4.n29')).toBeLessThan(text.indexOf('f0.n167'));
  });
});

describe('decide', () => {
  const scene = sceneOf(paragraph('p1', 'You wake.'), choice('c1', 'Call out'), choice('c2', 'Wait'));

  it('turns an act answer into a plan of those actions', async () => {
    const decision = await decide({
      scene,
      goal: 'survive',
      model: answering({ satisfied: '', remaining: 'survive', actions: [{ kind: 'clickTrigger', nodeId: 'c2' }] }),
    });
    expect(decision).toMatchObject({ decided: true, remaining: 'survive', actions: [{ kind: 'clickTrigger', nodeId: 'c2' }] });
    expect(decision.done).toBeUndefined();
  });

  it('turns a done answer into done, with no actions', async () => {
    const decision = await decide({ scene, goal: 'survive', model: answering({ satisfied: 'reached the ending', done: true }) });
    expect(decision).toMatchObject({ decided: true, done: true, satisfied: 'reached the ending', actions: [] });
  });

  it('rejects an empty action list instead of passing it on as "nothing to do"', async () => {
    await expect(
      decide({ scene, goal: 'survive', model: answering({ satisfied: '', remaining: 'survive', actions: [] }) }),
    ).rejects.toThrow();
  });
});
