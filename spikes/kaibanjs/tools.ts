// THROWAWAY SPIKE — the two Scene-mapped actions, expressed as KaibanJS tools.
//
// KaibanJS's `BaseTool` is a straight alias for LangChain's `StructuredTool`
// (dist/bundle.d.ts:8), so the whole tool surface is `tool()` from
// @langchain/core/tools: a zod schema in, a string out.
//
// Both tools validate the nodeId against the live Scene, so a hallucinated node
// id comes back as an error string the agent can recover from rather than a
// silent no-op.
import { tool, type StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Scene } from '../../utils/scene';

/** One decided actuation, as the bg worker would hand it down to the content script. */
export type EmittedAction =
  | { kind: 'setState'; nodeId: string; value: string }
  | { kind: 'clickTrigger'; nodeId: string };

export interface SceneTools {
  /** Actions the agent actually emitted, in call order. */
  emitted: EmittedAction[];
  tools: StructuredTool[];
}

export function makeSceneTools(scene: Scene): SceneTools {
  const emitted: EmittedAction[] = [];

  const setState = tool(
    async ({ nodeId, value }: { nodeId: string; value: string }) => {
      const node = scene.nodes[nodeId];
      if (!node || node.category !== 'state') {
        return `ERROR: '${nodeId}' is not a state node in this Scene.`;
      }
      emitted.push({ kind: 'setState', nodeId, value });
      return `OK: ${nodeId} now holds "${value}".`;
    },
    {
      name: 'setState',
      description:
        'Set the value of a state node (a text field) on the page. Convergent: re-applying the same value is a no-op.',
      schema: z.object({
        nodeId: z.string().describe('id of a Scene node whose category is "state"'),
        value: z.string().describe('the value to converge the control onto'),
      }),
    },
  );

  const clickTrigger = tool(
    async ({ nodeId }: { nodeId: string }) => {
      const node = scene.nodes[nodeId];
      if (!node || node.category !== 'action') {
        return `ERROR: '${nodeId}' is not an action node in this Scene.`;
      }
      emitted.push({ kind: 'clickTrigger', nodeId });
      return `OK: clicked ${nodeId}.`;
    },
    {
      name: 'clickTrigger',
      description:
        'Click an action node on the page. Discrete and possibly irreversible — click only when the state nodes are already correct.',
      schema: z.object({
        nodeId: z.string().describe('id of a Scene node whose category is "action"'),
      }),
    },
  );

  return { emitted, tools: [setState, clickTrigger] };
}

/** The Scene, flattened into the prompt-sized inventory the agent reasons over. */
export function describeScene(scene: Scene): string {
  const lines = Object.values(scene.nodes).map((n) => {
    const base = `- id="${n.id}" role=${n.role} name=${JSON.stringify(n.name ?? '')} category=${n.category}`;
    if (n.category === 'state') return `${base} control=${n.control} value=${JSON.stringify(n.value)}`;
    if (n.category === 'action') return `${base} action=${n.action}`;
    return base;
  });
  return [`PAGE: ${scene.title} <${scene.url}>`, 'NODES:', ...lines].join('\n');
}
