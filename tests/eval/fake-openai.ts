// A fake OpenAI endpoint.
//
// This file exists only because EvalKit has no offline mode: BaseMetric builds
// an `OpenAI` client in its constructor and every metric body calls
// `chat.completions.create({ model: 'gpt-4o-mini' })`. There is no injectable
// judge, so the only way to run an EvalKit metric in a hermetic unit test is to
// impersonate the OpenAI API over loopback.
//
// The "judge" here is deliberately trivial and fully visible: it reports the
// user message as the detected intent. That makes EvalKit's scoring exactly
// string equality, which is the honest demonstration — see EVAL-SPIKE-FINDINGS.md.
import http from 'node:http';

export interface JudgeCall {
  path: string;
  model: string;
  system: string;
  user: string;
}

export interface FakeJudge {
  baseURL: string;
  calls: JudgeCall[];
  close: () => Promise<void>;
}

interface ChatMessage {
  role: string;
  content: string;
}

/** The array shape IntentClassificationMetric parses out of the judge's reply. */
function intentReply(user: string) {
  return [{ intent: user, confidence: 1, similarity: { inputIntent: user, score: 1 } }];
}

export async function startFakeJudge(): Promise<FakeJudge> {
  const calls: JudgeCall[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { model?: string; messages?: ChatMessage[] };
      const messages = body.messages ?? [];
      calls.push({
        path: req.url ?? '',
        model: body.model ?? '',
        system: messages.find((m) => m.role === 'system')?.content ?? '',
        user: messages.find((m) => m.role === 'user')?.content ?? '',
      });
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'fake',
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify(intentReply(user)) },
            },
          ],
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake judge failed to bind');

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}
