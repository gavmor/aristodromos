// A stand-in for Ollama's POST /api/chat, for the offline e2e suite: the
// extension, the browser and the page are all real, only the model is not.
//
// It answers like a model that reads the outline: from the observation in the
// prompt it fills the login form's empty fields, ticks the box, then clicks the
// enabled submit, and says done once nothing is left. Memoryless, like the real
// brain: every answer comes from the page as described, never from earlier calls.
//
// `delayMs` holds every answer back, standing in for a model that takes longer
// than an idle background is allowed to live. `abandoned` records each request
// whose caller hung up before its answer: a decision that died with the
// background that asked for it.
import { createServer } from 'node:http';

export interface StubOllama {
  baseURL: string;
  /** when each /api/chat request arrived, in ms since the stub started */
  requests: number[];
  /** arrival times of requests whose caller went away before the answer */
  abandoned: number[];
  close(): Promise<void>;
}

/** `[f0.n6] (textbox) "Email address" = ""` -> its id and current value. */
function control(observation: string, name: string): { id: string; value: unknown } | undefined {
  const line = observation.split('\n').find((l) => l.includes(`"${name}"`) && /\[[^\]]+\]/.test(l));
  if (!line) return undefined;
  const id = /\[([^\]]+)\]/.exec(line)?.[1] as string;
  const value = / = (.*?)(?: options=| required| \[|$)/.exec(line)?.[1];
  return { id, value: value === undefined ? undefined : JSON.parse(value) };
}

function plan(prompt: string): object {
  const email = control(prompt, 'Email address');
  const password = control(prompt, 'Password');
  const remember = control(prompt, 'Remember this device');
  const actions = [
    email?.value === '' && { kind: 'setState', nodeId: email.id, value: 'alice@example.com' },
    password?.value === '' && { kind: 'setState', nodeId: password.id, value: 'hunter2' },
    remember?.value === false && { kind: 'setState', nodeId: remember.id, value: true },
  ].filter(Boolean);
  if (actions.length > 0) return { satisfied: 'nothing yet', remaining: 'fill the form', actions };
  const submit = control(prompt, 'Sign in');
  if (submit)
    return {
      satisfied: 'the form is filled',
      remaining: 'submit it',
      actions: [{ kind: 'clickTrigger', nodeId: submit.id }],
    };
  return { satisfied: 'signed in', done: true };
}

export async function startStubOllama(options: { delayMs?: number } = {}): Promise<StubOllama> {
  const started = Date.now();
  const requests: number[] = [];
  const abandoned: number[] = [];
  const server = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    if (req.method !== 'POST' || !req.url?.endsWith('/api/chat')) return void res.writeHead(404, cors).end();
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const arrived = Date.now() - started;
      requests.push(arrived);
      let answered = false;
      res.on('close', () => {
        if (!answered) abandoned.push(arrived);
      });
      const { model, messages } = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
      const prompt = messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');
      const answer = {
        model,
        created_at: new Date().toISOString(),
        done: true,
        done_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(plan(prompt)) },
      };
      setTimeout(() => {
        if (res.destroyed) return;
        answered = true;
        res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(JSON.stringify(answer));
      }, options.delayMs ?? 0);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const { port } = server.address() as { port: number };
  return {
    baseURL: `http://127.0.0.1:${port}/api`,
    requests,
    abandoned,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}
