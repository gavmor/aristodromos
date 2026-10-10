// MV3 bundling probe: can the RunMesh decision loop be bundled into a
// service worker? Imports exactly what the bg-worker brain would need.
// Bundled by spike/bundle-mv3.sh with --platform=browser, which is what
// WXT/Vite target for an MV3 service worker.
import { createOpenAI } from '@runmesh/core';
import { ToolRegistry, tool, type RegisteredTool } from '@runmesh/tools';
import { AgentExecutor } from '@runmesh/agent';
import { z } from 'zod';

export function makeBrain(model: string) {
  const tools = new ToolRegistry();
  tools.register(
    tool({
      name: 'clickTrigger',
      description: 'Click an action node.',
      schema: z.object({ nodeId: z.string() }),
      handler: ({ nodeId }) => ({ ok: true, nodeId }),
    }) as unknown as RegisteredTool,
  );
  return new AgentExecutor({
    name: 'aristodromos-bg',
    model,
    client: createOpenAI({
      apiKey: 'ollama',
      baseURL: 'http://localhost:11434/v1',
      defaultModel: model,
    }),
    tools,
  });
}
