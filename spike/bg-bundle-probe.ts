// THROWAWAY SPIKE — the MV3 bundle probe.
//
// Imported by entrypoints/background.ts purely so `pnpm build` is forced to
// pull @mastra/core's Agent into the service-worker chunk. Answers the only
// question that matters for this spike: does it bundle, and how big?
import { Agent } from '@mastra/core/agent';
import { LOGIN_SCENE } from './scene.fixture';
import { createSceneTools, describeScene, type EmittedAction } from './scene-tools';
import { resolveModel } from './model';

export async function decideWithMastra(goal: string): Promise<EmittedAction[]> {
  const { model } = await resolveModel();
  const emitted: EmittedAction[] = [];
  const agent = new Agent({
    id: 'scene-policy',
    name: 'scene-policy',
    instructions:
      'Drive the page with setState(nodeId, value) and clickTrigger(nodeId). Only use node ids from the Scene. Call the tools.',
    model,
    tools: createSceneTools(LOGIN_SCENE, emitted),
  });
  await agent.generate(`GOAL: ${goal}\n\nSCENE:\n${describeScene(LOGIN_SCENE)}`, {
    maxSteps: 4,
  });
  return emitted;
}
