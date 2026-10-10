// A live System-One decision against a real Jev-compatible server.
//
//   JEV_BASE_URL=http://localhost:18080 pnpm probe
//
// Opt-in and never part of `pnpm test`: it has its own config, and the root
// vitest config only collects `tests/**`. It needs a server, so it does not
// belong in a gate.
//
// Nothing here fakes the decision path. The Scene comes from the REAL
// SceneProjector run over the REAL e2e/fixtures/login.html — scripts and all,
// in jsdom — the questions come from the real `buildActionQuestions`, and the
// answer comes from whatever server JEV_BASE_URL points at. Only the browser is
// swapped out; this probe is about the DECISION, and e2e/run.ts already covers
// actuation end to end.
//
// It probes TWO states of the same page, because one classification proves very
// little: a model that always says "fill the email field" would pass a
// single-state probe. It has to FLIP to the trigger once the fields are filled
// and the page enables the button. That flip is the claim.
import { beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneProjector } from '../utils/scene-projector';
import { createSystemOneBrain } from '../utils/system-one-brain';
import { ACTION_QUESTION, buildActionQuestions, describeState } from '../utils/system-one-questions';
import { askSystemOne, isChoiceAnswer, isNoulAnswer, type FetchLike } from '../utils/system-one';
import type { Scene } from '../utils/scene';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Node's global fetch (undici) gives up 300 s after the request is sent if no
 * response HEADERS have arrived, and nothing in standard `fetch` can raise that
 * ceiling — `AbortSignal` can only shorten it. A 27B classifier served from CPU
 * takes longer than that for a single forward pass (measured: ~2.3 tok/s prompt
 * processing, so a 255-token state blob alone is ~110 s), and llama-server sends
 * no headers until the answer is ready. So the run dies with
 * `UND_ERR_HEADERS_TIMEOUT` while the SERVER is still working correctly.
 *
 * That ceiling is a property of the client, not of the decision under test, so
 * the probe injects a patient one through the `fetchImpl` seam `askSystemOne`
 * already exposes for its unit tests. The agent itself never needs this: in MV3
 * it runs on the browser's fetch, and a GPU-resident server answers in seconds.
 */
const patientFetch: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const outbound = send(
      target,
      { method: init.method ?? 'POST', headers: init.headers as Record<string, string>, timeout: 0 },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve(new Response(body, { status: response.statusCode ?? 502 })));
        response.on('error', reject);
      },
    );
    outbound.on('error', reject);
    init.signal?.addEventListener('abort', () => outbound.destroy(new Error('aborted')));
    outbound.end(init.body as string);
  });

const BASE_URL = process.env.JEV_BASE_URL ?? 'http://localhost:18080';
const MODEL = process.env.JEV_MODEL ?? 'autojev';
const GOAL = 'Sign in as alice@example.com with the password hunter2, and remember this device.';

/** Project the real fixture, optionally after driving it the way the agent would. */
async function project(fill: boolean): Promise<Scene> {
  const html = await readFile(path.join(HERE, 'fixtures', 'login.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1/login' });
  const { document } = dom.window;

  if (fill) {
    // Exactly what the reconciler does: set the value, then fire the event the
    // page listens for. The fixture's own `sync()` is what enables the button —
    // this never touches `disabled` itself.
    for (const [id, value] of [
      ['email', 'alice@example.com'],
      ['password', 'hunter2'],
    ] as const) {
      const el = document.getElementById(id) as HTMLInputElement;
      el.value = value;
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    (document.getElementById('remember') as HTMLInputElement).checked = true;
  }

  const projector = new SceneProjector({ root: document, emit: () => {}, schedule: () => {} });
  projector.scan();
  return projector.current;
}

/** Ask the server, print the whole answer as evidence, return the winning label. */
async function classify(title: string, scene: Scene): Promise<string> {
  const built = buildActionQuestions(scene);
  if (!built) throw new Error(`${title}: the scene affords nothing, so there is nothing to classify`);

  console.log(`\n[probe] ───────── ${title} ─────────`);
  for (const [label, target] of Object.entries(built.actions)) {
    console.log(`  option ${label.padEnd(30)} -> ${target.kind}(${target.nodeId})`);
  }

  const response = await askSystemOne({
    baseURL: BASE_URL,
    fetchImpl: patientFetch,
    request: { model: MODEL, state: describeState(scene, GOAL), questions: built.questions },
  });

  console.log(`  server:  ${response.model}  (${response.usage?.input_tokens ?? '?'} input tokens)`);
  for (const [name, answer] of Object.entries(response.answers)) {
    if (isChoiceAnswer(answer)) {
      const dist = Object.entries(answer.probabilities)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v.toFixed(3)}`)
        .join(' ');
      console.log(`  ${name}: choice=${answer.choice} confidence=${answer.confidence.toFixed(3)}`);
      console.log(`      p: ${dist}`);
    } else if (isNoulAnswer(answer)) {
      console.log(`  ${name}: P(yes)=${answer.noul.toFixed(3)}`);
    }
  }

  const chosen = response.answers[ACTION_QUESTION];
  if (!isChoiceAnswer(chosen)) throw new Error('no action choice came back');
  console.log(`  decoded: ${JSON.stringify(built.actions[chosen.choice])}`);
  return chosen.choice;
}

let empty: Scene;
let filled: Scene;

describe(`System-One over a real Scene @ ${BASE_URL}`, () => {
  beforeAll(async () => {
    empty = await project(false);
    filled = await project(true);
    console.log(`[probe] ${BASE_URL}/v1/systemone  model=${MODEL}`);
    console.log(`[probe] goal: ${GOAL}`);
  });

  it('withholds the disabled trigger from the option set entirely', () => {
    const built = buildActionQuestions(empty)!;
    expect(Object.values(built.actions).some((t) => t.kind === 'clickTrigger')).toBe(false);
    // ...while the state blob still DESCRIBES it, which is the signal to go fill
    // the fields first.
    expect(describeState(empty, GOAL)).toContain('DISABLED');
  });

  it('offers the trigger once the page itself enables it', () => {
    const built = buildActionQuestions(filled)!;
    expect(Object.values(built.actions).some((t) => t.kind === 'clickTrigger')).toBe(true);
  });

  it('picks a field to fill when the form is empty', async () => {
    expect(await classify('empty form (submit disabled)', empty)).toBe('fill_email_address');
  });

  it('flips to the commit trigger once the form is filled', async () => {
    expect(await classify('filled form (submit enabled)', filled)).toBe('click_sign_in');
  });

  it('the brain emits the decoded action with a calibrated confidence', async () => {
    const decision = await createSystemOneBrain({ baseURL: BASE_URL, model: MODEL, fetchImpl: patientFetch })({
      scene: filled,
      goal: GOAL,
    });
    console.log(`\n[probe] brain: via=${decision.via} confidence=${decision.confidence.toFixed(3)}`);
    console.log(`  actions: ${JSON.stringify(decision.actions)}`);
    if (decision.needsValue) console.log(`  needsValue=${decision.needsValue} (the gate would call the AI SDK brain)`);

    expect(decision.decided).toBe(true);
    const trigger = Object.values(buildActionQuestions(filled)!.actions).find((t) => t.kind === 'clickTrigger')!;
    expect(decision.actions).toEqual([{ kind: 'clickTrigger', nodeId: trigger.nodeId }]);
    expect(decision.confidence).toBeGreaterThan(0.5);
  });
});
