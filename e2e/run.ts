// "Let 'er rip": load the built extension into a headless browser, point it at
// a real multi-step form, and watch the loop run.
//
//   pnpm e2e            Chromium (the unpacked build)
//   pnpm e2e:firefox    Firefox  (the release zip, as a temporary add-on)
//
// Nothing here is mocked. The brain talks to the Ollama on this box, the content
// script drives a real DOM, and success is read from the PAGE — a flag the
// fixture's own submit handler sets — not from anything the agent claims. The
// run writes a JSONL turn log and exits non-zero if the loop did not converge.
//
// Node strips types natively, so this needs no build step of its own.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trainingJsonl } from '@gavmor/skene/training';
import type { AgentConfig } from '../utils/agent-config.ts';
import { type LoggedTurn, verifiedRowsOf } from '../utils/turn-log.ts';
import { chromiumHarness, firefoxHarness, type Harness } from './harness.ts';
import { startStubOllama } from './stub-ollama.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BROWSER = process.env.E2E_BROWSER === 'firefox' ? 'firefox' : 'chromium';
/**
 * `stub` (default): the offline suite. A scripted stand-in answers for the model
 * (stub-ollama.ts), so a run is fast and deterministic and can reproduce bugs.
 * `ollama`: the demo. The real local model decides; slow, and worth watching.
 */
const BRAIN = process.env.E2E_BRAIN === 'ollama' ? 'ollama' : 'stub';
// Demo runs are the evidence the repo keeps (Chromium where it always was);
// offline runs are reproducible, so theirs stays out of git.
const EVIDENCE =
  BRAIN === 'ollama'
    ? path.join(ROOT, 'e2e', 'evidence', ...(BROWSER === 'chromium' ? [] : [BROWSER]))
    : path.join(ROOT, '.output', 'e2e', BROWSER);

async function launch(): Promise<Harness> {
  if (BROWSER === 'chromium') return chromiumHarness(path.join(ROOT, '.output', 'chrome-mv3'));
  const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  return firefoxHarness(path.join(ROOT, '.output', `aristodromos-${version}-firefox.zip`));
}

const GOAL = 'Sign in as alice@example.com with the password hunter2, and remember this device.';
const EXPECT_EMAIL = 'alice@example.com';
const DEADLINE_MS = Number(process.env.E2E_DEADLINE_MS ?? (BRAIN === 'ollama' ? 900_000 : 120_000));

async function serveFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = await readFile(path.join(HERE, 'fixtures', 'login.html'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/login`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function main(): Promise<void> {
  const fixture = await serveFixture();
  const stub =
    BRAIN === 'stub' ? await startStubOllama({ delayMs: Number(process.env.E2E_STUB_DELAY_MS ?? 0) }) : undefined;
  const browser = await launch();

  try {
    // PHOENIX_COLLECTOR_ENDPOINT (e.g. http://localhost:6006/v1/traces) also
    // traces every decision of the run into the `aristodromos-e2e` project.
    const collector = process.env.PHOENIX_COLLECTOR_ENDPOINT;
    const config: AgentConfig = {
      goal: GOAL,
      model: process.env.OLLAMA_MODEL ?? 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
      baseURL: stub?.baseURL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/api',
      ...(collector ? { tracing: { endpoint: collector, project: 'aristodromos-e2e' } } : {}),
      // JEV_BASE_URL puts System One in front, so the run can also yield training rows.
      ...(process.env.JEV_BASE_URL
        ? {
            systemOne: {
              baseURL: process.env.JEV_BASE_URL,
              model: process.env.JEV_MODEL ?? 'autojev',
              threshold: Number(process.env.JEV_THRESHOLD ?? 0.6),
            },
          }
        : {}),
    };
    if (collector) console.log(`[e2e] tracing to ${collector} (project aristodromos-e2e)`);

    console.log(`[e2e] browser: ${BROWSER}, brain: ${BRAIN}${stub ? ` (${stub.baseURL})` : ''}`);
    console.log(`[e2e] goal: ${GOAL}`);
    console.log(`[e2e] navigating to ${fixture.url}`);
    await browser.openPage(fixture.url);

    // Set the goal and start the agent on this tab the way a user would: in
    // the toolbar popup, with Start.
    await browser.start(fixture.url, config);

    // Converged = the PAGE says so. No polling of agent state.
    const started = Date.now();
    let signedInAs: string | undefined;
    let remembered = false;
    while (Date.now() - started < DEADLINE_MS) {
      signedInAs = (await browser.pageValue('__signedInAs')) as string | undefined;
      if (signedInAs) {
        remembered = Boolean(await browser.pageValue('__rememberDevice'));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const turns = (await browser.turnLog()) as LoggedTurn[];

    await mkdir(EVIDENCE, { recursive: true });
    await writeFile(path.join(EVIDENCE, 'turns.jsonl'), `${turns.map((t) => JSON.stringify(t)).join('\n')}\n`);
    const consoleLines = await browser.consoleLines();
    await writeFile(path.join(EVIDENCE, 'content.log'), `${consoleLines.join('\n')}\n`);
    await browser.screenshot(path.join(EVIDENCE, 'final.png'));

    console.log('\n[e2e] ───────── turn log ─────────');
    for (const turn of turns) {
      const verbs = turn.actions.map((a) =>
        a.kind === 'setState' ? `setState(${a.nodeId}, ${JSON.stringify(a.value)})` : `clickTrigger(${a.nodeId})`,
      );
      console.log(
        `  tick ${turn.tick}  ${turn.ms}ms  Δ${turn.opsSinceLastTurn} ops  ` +
          `afforded[state=${turn.afforded.state.length} trigger=${turn.afforded.trigger.length}]`,
      );
      console.log(`         satisfied: ${JSON.stringify(turn.satisfied.slice(0, 120))}`);
      console.log(`         remaining: ${JSON.stringify(turn.remaining.slice(0, 120))}`);
      console.log(`         emitted:   ${verbs.length ? verbs.join(', ') : '(none)'}`);
      if (turn.error) console.log(`         ERROR:     ${turn.error}`);
    }

    // The claim being checked: the agent could not reach the trigger until it
    // had changed the world, so the sequence genuinely spans more than one turn.
    const firstTurn = turns[0];
    const clickTurn = turns.find((t) => t.actions.some((a) => a.kind === 'clickTrigger'));
    const multiStep = Boolean(firstTurn && clickTurn && clickTurn.tick > firstTurn.tick);

    console.log('\n[e2e] ───────── verdict ─────────');
    console.log(`  signed in as:          ${signedInAs ?? '(never)'}`);
    console.log(`  remember-device set:   ${remembered}`);
    console.log(`  turns taken:           ${turns.length}`);
    console.log(`  trigger withheld at t1:${firstTurn ? firstTurn.afforded.trigger.length === 0 : 'n/a'}`);
    console.log(`  multi-turn sequence:   ${multiStep}`);
    console.log(`  evidence:              ${EVIDENCE}`);
    // Every question put to the brain must get its answer heard. One the asker
    // hung up on is a decision that died with the background that asked it.
    if (stub) {
      const at = (times: number[]) => times.map((ms) => `${Math.round(ms / 1000)}s`).join(', ') || 'none';
      console.log(`  brain requests:        ${stub.requests.length} (at ${at(stub.requests)})`);
      console.log(`  abandoned mid-answer:  ${stub.abandoned.length} (at ${at(stub.abandoned)})`);
    }

    // A dead decision is the more specific failure, so it is reported first.
    if (stub && stub.abandoned.length > 0) {
      throw new Error(
        `${stub.abandoned.length} decision(s) died before the brain answered: the background was stopped under them`,
      );
    }
    if (signedInAs !== EXPECT_EMAIL) {
      throw new Error(`did not converge: expected ${EXPECT_EMAIL}, page reports ${signedInAs ?? 'nothing'}`);
    }
    if (!multiStep) throw new Error('converged, but within a single turn — no perceive/act cycle demonstrated');
    console.log('\n[e2e] PASS — perceive -> decide -> actuate -> re-perceive closed the loop.');

    // The page's own post-conditions are the verifier: only a run that met the
    // whole goal (signed in AND remembered) may become training data.
    if (remembered && turns[0]?.tabId !== undefined) {
      const rows = verifiedRowsOf(turns, turns[0].tabId, `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      await writeFile(path.join(EVIDENCE, 'training.jsonl'), trainingJsonl(rows));
      console.log(
        `[e2e] training rows: ${rows.length} (System One turns that moved the page) -> ${path.relative(ROOT, path.join(EVIDENCE, 'training.jsonl'))}`,
      );
    } else {
      console.log('[e2e] no training export: the goal was not fully met (remember-device unset)');
    }
  } finally {
    await browser.close();
    await fixture.close();
    await stub?.close();
  }
}

await main();
