// Isolate RunMesh's schema generation as the defect.
//
// RunMesh's toOpenAITool() emits zod-to-json-schema's default shape:
//   parameters: { $ref: "#/definitions/X", definitions: { X: {...} } }
// OpenAI's function-calling contract wants a FLAT object schema. This probe
// sends the identical request twice — once with RunMesh's $ref form, once with
// the equivalent inlined schema — and reports which argument names come back.
const model = process.argv[2] ?? 'qwen3-coder-ud-q4kxl:latest';

const refStyle = {
  type: 'function',
  function: {
    name: 'setState',
    description: 'Set the value of a state node (a text input).',
    parameters: {
      $ref: '#/definitions/setState',
      definitions: {
        setState: {
          type: 'object',
          properties: { nodeId: { type: 'string' }, value: { type: 'string' } },
          required: ['nodeId', 'value'],
          additionalProperties: false,
        },
      },
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
  },
};

const inlineStyle = {
  type: 'function',
  function: {
    name: 'setState',
    description: 'Set the value of a state node (a text input).',
    parameters: {
      type: 'object',
      properties: { nodeId: { type: 'string' }, value: { type: 'string' } },
      required: ['nodeId', 'value'],
      additionalProperties: false,
    },
  },
};

async function ask(label: string, toolDef: unknown) {
  const res = await fetch('http://localhost:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ollama' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Call tools to drive the page. Never invent ids.' },
        { role: 'user', content: 'Nodes: id="email" (text input).\nGoal: set email to alice@example.com' },
      ],
      tools: [toolDef],
      temperature: 0,
      stream: false,
    }),
  });
  const json = await res.json();
  const calls = json.choices?.[0]?.message?.tool_calls ?? [];
  const args = calls.map((c: { function: { arguments: string } }) => c.function.arguments);
  console.log(`${label}:`);
  console.log(`  tool_calls: ${calls.length}`);
  console.log(`  arguments:  ${args.join(' | ') || '(none)'}`);
  const keys = args.flatMap((a: string) => {
    try {
      return Object.keys(JSON.parse(a));
    } catch {
      return ['<unparseable>'];
    }
  });
  console.log(`  arg keys:   ${keys.join(', ') || '(none)'}`);
  console.log(`  correct:    ${keys.includes('nodeId') && !keys.includes('id')}\n`);
}

console.log(`model: ${model}\n`);
await ask('RunMesh $ref-wrapped schema', refStyle);
await ask('inlined flat schema      ', inlineStyle);

export {};
