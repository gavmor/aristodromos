// THROWAWAY SPIKE — MV3 service-worker bundle probe.
//
// Imported by entrypoints/background.ts purely so `pnpm build` has to pull the
// whole KaibanJS module graph into the MV3 service-worker chunk. Never called.
// See SPIKE-FINDINGS.md for what the build actually said.
import { Agent, Task, Team } from 'kaibanjs';
import { ChatOllama } from '@langchain/ollama';
import { LOGIN_SCENE } from './scene.fixture';
import { describeScene, makeSceneTools } from './tools';

export async function decideInServiceWorker(goal: string): Promise<unknown> {
  const { tools, emitted } = makeSceneTools(LOGIN_SCENE);
  const agent = new Agent({
    name: 'Projector',
    role: 'Web page operator',
    goal: 'Drive the page toward the user goal using only Scene node ids.',
    background: 'Reasons over a semantic projection of the live page.',
    tools,
    llmInstance: new ChatOllama({
      baseUrl: 'http://localhost:11434',
      model: 'qwen3-coder-ud-q4kxl:latest',
    }),
  });
  const task = new Task({
    title: 'Decide one step',
    description: `GOAL: ${goal}\n\n${describeScene(LOGIN_SCENE)}`,
    expectedOutput: 'A one-line summary of the actuations performed.',
    agent,
  });
  await new Team({ name: 'bg-worker', agents: [agent], tasks: [task], env: {} }).start();
  return emitted;
}
