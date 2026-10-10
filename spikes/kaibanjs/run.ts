// THROWAWAY SPIKE — one KaibanJS decision over one Scene. Happy path only.
//
// Run: pnpm spike:kaibanjs
//
// The bg worker is only the brain: Scene in, action plan out. So this wires the
// smallest possible KaibanJS shape — ONE Agent, ONE Task, ONE Team — and asks
// whether the multi-agent/Kanban-board machinery can be reduced to that.
import { Agent, Task, Team } from 'kaibanjs';
import { ChatOllama } from '@langchain/ollama';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LOGIN_SCENE } from './scene.fixture';
import { describeScene, makeSceneTools } from './tools';

const OLLAMA_URL = 'http://localhost:11434';
const GOAL = 'sign in as alice@example.com';

/** Canned ReAct turns for the offline path — KaibanJS parses this JSON by regex. */
const CANNED = [
  JSON.stringify({
    thought: 'The email field is empty; fill it before submitting.',
    action: 'setState',
    actionInput: { nodeId: 'email', value: 'alice@example.com' },
  }),
  JSON.stringify({ observation: 'The email field now holds the address.', isFinalAnswerReady: false }),
  JSON.stringify({
    thought: 'State is correct, so the submit trigger is now safe to fire.',
    action: 'clickTrigger',
    actionInput: { nodeId: 'signin' },
  }),
  JSON.stringify({ observation: 'The form was submitted.', isFinalAnswerReady: true }),
  JSON.stringify({ finalAnswer: 'Set email to alice@example.com and clicked signin.' }),
];

async function pickModel(): Promise<{ llm: BaseChatModel; label: string }> {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(2000),
  }).catch(() => null);

  if (res?.ok) {
    const { models } = (await res.json()) as { models: { name: string }[] };
    const qwens = models.filter((m) => /qwen/i.test(m.name) && !/embed/i.test(m.name));
    // Prefer a coder/instruct variant: the ReAct loop is pure JSON emission.
    const qwen = qwens.find((m) => /coder|instruct/i.test(m.name)) ?? qwens[0];
    if (qwen) {
      return {
        llm: new ChatOllama({ baseUrl: OLLAMA_URL, model: qwen.name, temperature: 0 }),
        label: `LIVE Ollama — ${qwen.name}`,
      };
    }
  }
  return {
    llm: new FakeListChatModel({ responses: CANNED }),
    label: 'MOCK (Ollama unreachable) — canned ReAct tool-calls',
  };
}

async function main(): Promise<void> {
  const { llm, label } = await pickModel();
  console.log(`\n=== KaibanJS spike — model: ${label} ===\n`);

  const { tools, emitted } = makeSceneTools(LOGIN_SCENE);

  const agent = new Agent({
    name: 'Projector',
    role: 'Web page operator',
    goal: 'Drive a web page toward the user goal using only the nodes in the Scene.',
    background:
      'You reason over a semantic projection of a live page and emit actuations. ' +
      'You never invent node ids; you only use ids listed in the Scene.',
    tools,
    llmInstance: llm,
    maxIterations: 6,
  });

  const task = new Task({
    title: 'Decide one step',
    description: `GOAL: ${GOAL}\n\n${describeScene(LOGIN_SCENE)}\n\nFill any state node the goal requires, then fire the one trigger that commits it.`,
    expectedOutput: 'A one-line summary of the actuations you performed.',
    agent,
  });

  const team = new Team({ name: 'bg-worker', agents: [agent], tasks: [task], env: {} });

  const result = await team.start();

  console.log('--- emitted actions ---');
  for (const a of emitted) console.log(JSON.stringify(a));
  console.log('--- workflow status ---');
  console.log(result.status, '|', JSON.stringify(result.result));
}

main().catch((err: unknown) => {
  console.error('SPIKE FAILED:', err);
  throw err;
});
