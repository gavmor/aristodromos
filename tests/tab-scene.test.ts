import { describe, expect, it } from 'vitest';
import { MIN_FRAME_SIDE, TabScene, splitNodeId } from '../utils/tab-scene';
import type { ActionNode, Scene, StateNode } from '../utils/scene';
import { actionNode, stateNode } from './fixtures/scene';

const frameScene = (
  documentId: string,
  nodes: (StateNode | ActionNode)[],
  over: Partial<Scene> = {},
): Scene => ({
  documentId,
  url: `https://${documentId}.test/`,
  title: documentId,
  viewport: { w: 800, h: 600, scrollX: 0, scrollY: 0 },
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
  ...over,
});

describe('TabScene', () => {
  it('composes frames into one Scene, every id namespaced by its frame', () => {
    const tab = new TabScene();
    tab.ingest(0, {
      kind: 'snapshot',
      scene: frameScene('top', [stateNode({ id: 'n1', relations: { labelledBy: ['n2'] } }), actionNode({ id: 'n2', submits: { formId: 'n9', method: 'post' } })], { focusedId: 'n1' }),
    });
    tab.ingest(14, { kind: 'snapshot', scene: frameScene('game', [actionNode({ id: 'n1', name: 'Wait' })]) });

    const scene = tab.current!;
    expect(Object.keys(scene.nodes).sort()).toEqual(['f0.n1', 'f0.n2', 'f14.n1']);
    expect(scene.nodes['f0.n1'].relations.labelledBy).toEqual(['f0.n2']);
    expect((scene.nodes['f0.n2'] as ActionNode).submits?.formId).toBe('f0.n9');
    expect(scene.focusedId).toBe('f0.n1');
    expect(scene.url).toBe('https://top.test/');
    expect(scene.frames).toEqual({
      0: { documentId: 'top', url: 'https://top.test/', title: 'top' },
      14: { documentId: 'game', url: 'https://game.test/', title: 'game' },
    });
    expect(splitNodeId('f14.n1')).toEqual({ frameId: 14, nodeId: 'n1' });
  });

  it('leaves out frames too small to matter, but never the top frame', () => {
    const tab = new TabScene();
    const tiny = { viewport: { w: 1, h: 1, scrollX: 0, scrollY: 0 } };
    tab.ingest(0, { kind: 'snapshot', scene: frameScene('top', [actionNode({ id: 'n1' })], tiny) });
    tab.ingest(3, { kind: 'snapshot', scene: frameScene('pixel', [actionNode({ id: 'n1' })], tiny) });
    tab.ingest(4, {
      kind: 'snapshot',
      scene: frameScene('strip', [actionNode({ id: 'n1' })], { viewport: { w: 800, h: MIN_FRAME_SIDE - 1, scrollX: 0, scrollY: 0 } }),
    });
    expect(Object.keys(tab.current!.nodes)).toEqual(['f0.n1']);
    expect(Object.keys(tab.current!.frames)).toEqual(['0']);
  });

  it('applies a patch to its own frame only, though local ids collide', () => {
    const tab = new TabScene();
    tab.ingest(0, { kind: 'snapshot', scene: frameScene('top', [stateNode({ id: 'n1' })]) });
    tab.ingest(7, { kind: 'snapshot', scene: frameScene('inner', [stateNode({ id: 'n1' })]) });
    tab.ingest(7, { kind: 'patch', documentId: 'inner', ops: [{ op: 'replace', path: '/nodes/n1/value', value: 'typed' }] });

    expect((tab.current!.nodes['f7.n1'] as StateNode).value).toBe('typed');
    expect((tab.current!.nodes['f0.n1'] as StateNode).value).toBe('');
  });

  it('is a new world when any frame changes document, and loses a frame that goes away', () => {
    const tab = new TabScene();
    tab.ingest(0, { kind: 'snapshot', scene: frameScene('top', [actionNode({ id: 'n1' })]) });
    tab.ingest(5, { kind: 'snapshot', scene: frameScene('page1', [actionNode({ id: 'n1' })]) });
    const before = tab.current!.documentId;

    tab.ingest(5, { kind: 'snapshot', scene: frameScene('page2', [actionNode({ id: 'n1' })]) });
    expect(tab.current!.documentId).not.toBe(before);

    expect(tab.drop(5)).toBe(true);
    expect(Object.keys(tab.current!.nodes)).toEqual(['f0.n1']);
    expect(tab.drop(5)).toBe(false);
  });

  it('is settled only while every frame last said so', () => {
    const tab = new TabScene();
    tab.ingest(0, { kind: 'snapshot', scene: frameScene('top', [actionNode({ id: 'n1' })]), settled: true });
    expect(tab.settled).toBe(true);
    tab.ingest(2, { kind: 'snapshot', scene: frameScene('inner', [actionNode({ id: 'n1' })]) });
    expect(tab.settled).toBe(false);
    tab.ingest(2, { kind: 'snapshot', scene: frameScene('inner', [actionNode({ id: 'n1' })]), settled: true });
    expect(tab.settled).toBe(true);
    tab.ingest(0, { kind: 'patch', documentId: 'top', ops: [{ op: 'replace', path: '/title', value: 'moved' }] });
    expect(tab.settled).toBe(false);
  });
});
