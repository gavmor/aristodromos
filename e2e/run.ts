// "Let 'er rip": load the built extension into a headless Chromium, point it at
// a real multi-step form, and watch the loop run.
//
//   pnpm build && node e2e/run.ts
//
// Nothing here is mocked. The brain talks to the Ollama on this box, the content
// script drives a real DOM, and success is read from the PAGE — a flag the
// fixture's own submit handler sets — not from anything the agent claims. The
// run writes a JSONL turn log and exits non-zero if the loop did not converge.
//
// Node 26 strips types natively, so this needs no build step of its own.
import { chromium, type BrowserContext, type Worker } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXTENSION = path.join(ROOT, '.output', 'chrome-mv3');
const EVIDENCE = path.join(ROOT, 'e2e', 'evidence');

/**
 * Declared, not imported: the `chrome` below appears only inside
 * `worker.evaluate` bodies, which Playwright serialises and runs in the
 * EXTENSION service worker. It never exists in this Node process.
 */
declare const chrome: {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
};

const GOAL =
  'Sign in as alice@example.com with the password hunter2, and remember this device.';
const EXPECT_EMAIL = 'alice@example.com';
const DEADLINE_MS = Number(process.env.E2E_DEADLINE_MS ?? 240_000);

interface TurnRecord {
  tick: number;
  url: string;
  opsSinceLastTurn: number;
  afforded: { state: string[]; trigger: string[] };
  satisfied: string;
  remaining: string;
  actions: { kind: string; nodeId: string; value?: unknown }[];
  ms: number;
  error?: string;
}

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

/** MV3 service workers can be asleep; poke the context until one shows up. */
async function serviceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout: 30_000 });
}

async function main(): Promise<void> {
  const fixture = await serveFixture();
  const profile = await mkdtemp(path.join(tmpdir(), 'aristodromos-e2e-'));
  const pageConsole: string[] = [];

  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--no-sandbox',
    ],
  });

  try {
    const worker = await serviceWorker(context);
    console.log(`[e2e] extension service worker up: ${worker.url()}`);

    // Set the goal the way a user would: through the extension's own storage.
    await worker.evaluate(
      async ([goal, model]) => {
        await chrome.storage.local.set({
          agentConfig: { goal, model, baseURL: 'http://localhost:11434/api' },
          turnLog: [],
        });
      },
      [GOAL, process.env.OLLAMA_MODEL ?? 'qwen3-coder-ud-q4kxl:latest'],
    );

    const page = await context.newPage();
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('[agent]')) {
        pageConsole.push(text);
        console.log(`  page ${text}`);
      }
    });

    console.log(`[e2e] goal: ${GOAL}`);
    console.log(`[e2e] navigating to ${fixture.url}`);
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });

    // Converged = the PAGE says so. No polling of agent state.
    const started = Date.now();
    let signedInAs: string | undefined;
    let remembered = false;
    while (Date.now() - started < DEADLINE_MS) {
      signedInAs = await page.evaluate(() => (window as unknown as { __signedInAs?: string }).__signedInAs);
      if (signedInAs) {
        remembered = Boolean(
          await page.evaluate(() => (window as unknown as { __rememberDevice?: boolean }).__rememberDevice),
        );
        break;
      }
      await page.waitForTimeout(1000);
    }

    const turns = (await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('turnLog');
      return stored.turnLog ?? [];
    })) as TurnRecord[];

    await mkdir(EVIDENCE, { recursive: true });
    await writeFile(path.join(EVIDENCE, 'turns.jsonl'), turns.map((t) => JSON.stringify(t)).join('\n') + '\n');
    await writeFile(path.join(EVIDENCE, 'content.log'), pageConsole.join('\n') + '\n');
    await page.screenshot({ path: path.join(EVIDENCE, 'final.png'), fullPage: true });

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

    if (signedInAs !== EXPECT_EMAIL) {
      throw new Error(`did not converge: expected ${EXPECT_EMAIL}, page reports ${signedInAs ?? 'nothing'}`);
    }
    if (!multiStep) throw new Error('converged, but within a single turn — no perceive/act cycle demonstrated');
    console.log('\n[e2e] PASS — perceive -> decide -> actuate -> re-perceive closed the loop.');
  } finally {
    await context.close();
    await fixture.close();
  }
}

await main();
