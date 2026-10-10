// Isolate: is the missing tool_calls RunMesh's fault or the model's?
// Prints the tool JSON RunMesh generates, then replays the SAME payload
// straight at Ollama's OpenAI-compat endpoint, bypassing RunMesh entirely.
import { installRunMeshResolveShim } from './runmesh-resolve-hook.ts';
import type { RegisteredTool } from '@runmesh/tools';

installRunMeshResolveShim();

const { ToolRegistry, tool } = await import('@runmesh/tools');
const { z } = await import('zod');

const tools = new ToolRegistry();
tools.register(
  tool({
    name: 'setState',
    description: 'Set the value of a state node (a text input).',
    schema: z.object({ nodeId: z.string(), value: z.string() }),
    handler: () => ({ ok: true }),
  }) as unknown as RegisteredTool,
);
tools.register(
  tool({
    name: 'clickTrigger',
    description: 'Click an action node (a button).',
    schema: z.object({ nodeId: z.string() }),
    handler: () => ({ ok: true }),
  }) as unknown as RegisteredTool,
);

const openAITools = tools.toOpenAITools();
console.log('=== RunMesh toOpenAITools() ===');
console.log(JSON.stringify(openAITools, null, 2));

const model = process.argv[2] ?? 'qwen3-coder-ud-q4kxl:latest';
const body = {
  model,
  messages: [
    { role: 'system', content: 'Call tools to drive the page. Never invent ids.' },
    {
      role: 'user',
      content:
        'Nodes: id="email" (text input), id="signin" (button).\n' +
        'Goal: sign in as alice@example.com',
    },
  ],
  tools: openAITools,
  stream: false,
};

console.log(`\n=== raw Ollama /v1/chat/completions (${model}) ===`);
const res = await fetch('http://localhost:11434/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ollama' },
  body: JSON.stringify(body),
});
const json = await res.json();
const msg = json.choices?.[0]?.message;
console.log(`HTTP ${res.status}`);
console.log(`tool_calls: ${JSON.stringify(msg?.tool_calls ?? null, null, 2)}`);
console.log(`content: ${JSON.stringify(msg?.content ?? null)}`);
