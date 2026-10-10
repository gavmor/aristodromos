// THROWAWAY SPIKE — maps Scene nodes 1:1 onto Mastra tools.
//
// The bg worker is only the brain: these tools do NOT touch a DOM. They record
// the decision the model reached so the caller can hand it to the content
// script's actuator.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NodeId, Scene } from '../utils/scene';

export type EmittedAction =
  | { kind: 'setState'; nodeId: NodeId; value: string }
  | { kind: 'clickTrigger'; nodeId: NodeId };

type IdEnum = [string, ...string[]];

function idsByCategory(scene: Scene, category: 'state' | 'action'): IdEnum {
  const ids = Object.values(scene.nodes)
    .filter((n) => n.category === category && !n.perception.disabled)
    .map((n) => n.id);
  if (ids.length === 0) throw new Error(`scene has no ${category} nodes`);
  return ids as IdEnum;
}

/** One line per node — the whole observation the model gets. */
export function describeScene(scene: Scene): string {
  const lines = Object.values(scene.nodes).map((n) => {
    const head = `${n.id} [${n.category}/${n.role}] "${n.name ?? ''}"`;
    if (n.category === 'state') return `${head} value=${JSON.stringify(n.value)}`;
    if (n.category === 'action') return `${head} action=${n.action}`;
    return head;
  });
  return `URL ${scene.url}\nTITLE ${scene.title}\nNODES\n${lines.map((l) => `  ${l}`).join('\n')}`;
}

/**
 * Two tools, their node-id argument constrained to ids that actually exist in
 * this Scene. Re-derived per observation, which is exactly the memoryless
 * contract: the tool surface IS the current page.
 */
export function createSceneTools(scene: Scene, emitted: EmittedAction[]) {
  return {
    setState: createTool({
      id: 'setState',
      description:
        'Set the value of a state node (text input, checkbox, select) on the current page.',
      inputSchema: z.object({
        nodeId: z.enum(idsByCategory(scene, 'state')).describe('Scene state node id'),
        value: z.string().describe('The value to converge the control on'),
      }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async ({ nodeId, value }) => {
        emitted.push({ kind: 'setState', nodeId, value });
        return { ok: true };
      },
    }),
    clickTrigger: createTool({
      id: 'clickTrigger',
      description: 'Actuate an action node (button, link) on the current page.',
      inputSchema: z.object({
        nodeId: z.enum(idsByCategory(scene, 'action')).describe('Scene action node id'),
      }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async ({ nodeId }) => {
        emitted.push({ kind: 'clickTrigger', nodeId });
        return { ok: true };
      },
    }),
  };
}
