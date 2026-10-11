import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { decide, describeScene } from '../utils/brain';
import { buildActionSchema } from '../utils/action-schema';
import { SceneProjector } from '../utils/scene-projector';
import { TabScene } from '../utils/tab-scene';
import type { ActionNode, ContentNode, Perception, Scene, SceneNode, StructureNode } from '../utils/scene';

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
  order: 0,
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
  order: 0,
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

  it('caps any one block, so a wall of text cannot crowd out the rest', () => {
    const wall = 'w'.repeat(5000);
    const text = describeScene(sceneOf(paragraph('p1', wall), paragraph('p2', 'The passage that matters.')));
    expect(text).toContain(JSON.stringify(`${'w'.repeat(1500)}…`));
    expect(text).toContain('"The passage that matters."');
  });

  it('bounds page text by one overall budget and says what it left out', () => {
    const block = 'x'.repeat(1500);
    const blocks = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => paragraph(id, block));
    const text = describeScene(sceneOf(...blocks));
    expect(text.split(JSON.stringify(block)).length - 1).toBe(4); // four fit whole
    expect(text).toContain('(1 more text blocks omitted)');
  });

  it('spends the text budget on what is on screen first, and still reads in page order', () => {
    const offscreen = (id: string): ContentNode => ({ ...paragraph(id, 'c'.repeat(1500)), perception: { ...perception, inViewport: false } });
    const story = 'You wake in a tunnel.';
    // Page order puts a store page's comments first; the game's passage is on screen.
    const text = describeScene(sceneOf(...['p1', 'p2', 'p3', 'p4', 'p5'].map(offscreen), paragraph('p6', story)));
    expect(text).toContain(JSON.stringify(story));
    expect(text).toContain('(1 more text blocks omitted)');
    expect(text.indexOf('ccc')).toBeLessThan(text.indexOf(story));
  });

  /** The real projector over real markup: these are about what a page reads as. */
  const outlineOf = (html: string): string => {
    document.body.innerHTML = html;
    const snapshot = new SceneProjector({ root: document, emit: () => {}, schedule: () => {} }).scan();
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot');
    return describeScene(snapshot.scene);
  };
  const indent = (line: string): number => line.length - line.trimStart().length;

  it('reads a table row as one line, each value beside its label, in page order', () => {
    const text = outlineOf(
      '<h2>Status</h2><table><tr><td>Atmosphere:</td><td>100%</td></tr><tr><td>Hull:</td><td>40%</td></tr></table>' +
        '<p>Something scrapes against the hull.</p><button>Seal the airlock</button>',
    );
    expect(text).toContain('(row) Atmosphere: | 100%');
    expect(text).toContain('(row) Hull: | 40%');
    expect(text.indexOf('(heading 2) "Status"')).toBeLessThan(text.indexOf('(row) Atmosphere'));
    expect(text.indexOf('(row) Hull')).toBeLessThan(text.indexOf('Something scrapes'));
    expect(text).toMatch(/\[n\d+\] \(button\) "Seal the airlock"/);
  });

  it('nests controls inside their container, with ids only where the schema can act', () => {
    const lines = outlineOf('<form aria-label="Sign in"><label>Email <input type="text"></label><button disabled>Go</button></form>').split('\n');
    const form = lines.findIndex((line) => line.includes('(form) "Sign in"'));
    expect(lines[form + 1]).toMatch(/\[n\d+\] \(textbox\) "Email" = ""/);
    expect(indent(lines[form + 1])).toBeGreaterThan(indent(lines[form]));
    const go = lines.find((line) => line.includes('"Go"'));
    expect(go).toMatch(/\(button\) "Go" \[disabled\]$/);
    expect(go).not.toMatch(/\[n\d+\]/);
  });

  it('leaves out what the page hides', () => {
    const text = outlineOf('<nav aria-label="Menu" style="display:none"><a href="/secret">Secret</a></nav><a href="/shown">Shown</a>');
    expect(text).not.toContain('Secret');
    expect(text).toMatch(/\(link\) "Shown"/);
  });

  it('says where a link goes, cutting long addresses and skipping script', () => {
    const long = `https://ads.example/track?${'x'.repeat(200)}`;
    const text = outlineOf(
      `<a href="/chapter-2">Next</a><a href="${long}">Games like this</a><a href="javascript:void(0)" onclick="go()">Go</a>`,
    );
    expect(text).toMatch(/\(link\) "Next" <\/chapter-2>/);
    expect(text).toContain(`"Games like this" <${long.slice(0, 100)}…>`);
    expect(text).toMatch(/\(link\) "Go"(?! <)/);
  });

  it('neither lists nor lets the model name a control its container hides', () => {
    document.body.innerHTML = '<div id="section16" style="display:none"><button>Confirm</button></div><button>Continue</button>';
    const snapshot = new SceneProjector({ root: document, emit: () => {}, schedule: () => {} }).scan();
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot');
    const text = describeScene(snapshot.scene);
    expect(text).not.toContain('Confirm');
    const confirm = Object.values(snapshot.scene.nodes).find((n) => n.name === 'Confirm')!;
    expect(buildActionSchema(snapshot.scene)!.triggerIds).not.toContain(confirm.id);
  });

  it('keeps a control the page renders at opacity 0, as custom radios do', () => {
    const text = outlineOf('<label><input type="radio" name="c" style="opacity:0"> No thanks</label>');
    expect(text).toMatch(/\[n\d+\] \(radio\) "No thanks"/);
  });

  it('reads a story passage that is bare text in a div', () => {
    const text = outlineOf(
      '<div class="passage">PROLOGUE<br>You come home to <em>screaming</em>.<br><a href="#run">Run</a></div>',
    );
    expect(text).toContain('(text) "PROLOGUE You come home to screaming."');
    expect(text.indexOf('PROLOGUE')).toBeLessThan(text.indexOf('"Run"'));
  });

  it('reads an embedded frame where its iframe sits in the page', () => {
    const host: StructureNode = { id: 'n2', role: 'iframe', category: 'structure', frameSrc: 'https://game.test/', relations: {}, perception, order: 1 };
    const tab = new TabScene();
    tab.ingest(0, {
      kind: 'snapshot',
      scene: sceneOf({ ...paragraph('n1', 'A Tale of Crowns'), order: 0 }, host, { ...paragraph('n3', 'Comments'), order: 2 }),
    });
    tab.ingest(4, {
      kind: 'snapshot',
      scene: { ...sceneOf(paragraph('n1', 'You wake.'), { ...choice('n2', 'Call out'), order: 1 }), url: 'https://game.test/', documentId: 'game' },
    });

    const lines = describeScene(tab.current!).split('\n');
    const iframe = lines.findIndex((line) => line.includes('(iframe)'));
    const passage = lines.findIndex((line) => line.includes('You wake.'));
    expect(passage).toBe(iframe + 1);
    expect(indent(lines[passage])).toBeGreaterThan(indent(lines[iframe]));
    expect(lines.findIndex((line) => line.includes('[f4.n2] (link) "Call out"'))).toBeLessThan(
      lines.findIndex((line) => line.includes('Comments')),
    );
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
