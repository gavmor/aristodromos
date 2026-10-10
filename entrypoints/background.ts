// Background: the decision half.
//
// One AgentLoop per connected content script. The service worker holds no
// authoritative state — the Scene replica is rebuilt from the up-edge stream, so
// an MV3 eviction costs nothing but a reconnect. Control state (goal, brain,
// pause) lives in `browser.storage.local`; the toolbar button and the devtools
// panel write it, and this worker follows `storage.onChanged`.
import { createOllama } from 'ollama-ai-provider-v2';
import { AgentLoop } from '../utils/agent-loop';
import { aiSdkBrain, nothingAfforded, type Brain } from '../utils/brain';
import { createGatedBrain, createSystemOneBrain } from '../utils/system-one-brain';
import {
  CONFIG_KEY,
  DECIDE_NOW_KEY,
  PAUSED_KEY,
  PENDING_KEY,
  TURN_LOG_KEY,
  resolveConfig,
  type AgentConfig,
} from '../utils/agent-config';
import type { ScenePatch } from '../utils/scene';
import { AGENT_PORT, type PendingDecision, type TurnRecord } from '../utils/wire';

const TURN_LOG_CAP = 200;

/** Serialise the read-modify-write; two ports can settle in the same tick. */
let logWrites: Promise<void> = Promise.resolve();

async function readConfig(): Promise<AgentConfig> {
  const stored = await browser.storage.local.get(CONFIG_KEY);
  return resolveConfig(stored[CONFIG_KEY]);
}

function appendTurn(turn: TurnRecord): void {
  logWrites = logWrites.then(async () => {
    const stored = await browser.storage.local.get(TURN_LOG_KEY);
    const log = (Array.isArray(stored[TURN_LOG_KEY]) ? stored[TURN_LOG_KEY] : []) as TurnRecord[];
    log.push(turn);
    await browser.storage.local.set({ [TURN_LOG_KEY]: log.slice(-TURN_LOG_CAP) });
  });
}

async function setBadge(paused: boolean): Promise<void> {
  await browser.action.setBadgeText({ text: paused ? '⏸' : '▶' });
  await browser.action.setBadgeBackgroundColor({ color: paused ? '#666666' : '#2e7d32' });
}

/**
 * Assemble the brain for one decision. The seam is a plain function, so the
 * loop cannot tell which side of it answered.
 *
 * With `systemOne` configured the cheap classifier decides first and the Ollama
 * brain becomes the confidence-gated fallback; without it, the Ollama brain is
 * the whole brain, exactly as before.
 */
function brainFor(config: AgentConfig): Brain {
  const ollama = createOllama({ baseURL: config.baseURL });
  const slow = aiSdkBrain(ollama.chat(config.model));
  if (!config.systemOne) return slow;

  return createGatedBrain({
    fast: createSystemOneBrain({ baseURL: config.systemOne.baseURL, model: config.systemOne.model }),
    slow,
    threshold: config.systemOne.threshold,
  });
}

export default defineBackground(() => {
  // Paused until storage says otherwise: a worker woken after eviction must not
  // act on a page the user had paused.
  let paused = true;
  /** every connected page's loop, with the tab it drives */
  const loops = new Map<AgentLoop, number | undefined>();
  const pending = new Map<AgentLoop, PendingDecision>();

  const publishPending = (): void => {
    void browser.storage.session.set({ [PENDING_KEY]: [...pending.values()] });
  };
  // A fresh worker has no loops, so nothing it inherited can still be in flight.
  publishPending();

  const applyPaused = (next: boolean): void => {
    paused = next;
    for (const loop of loops.keys()) loop.setPaused(paused);
    void setBadge(paused);
    console.log(`[agent] ${paused ? 'paused' : 'resumed'}`);
  };

  void browser.storage.local.get(PAUSED_KEY).then((stored) => applyPaused(stored[PAUSED_KEY] === true));

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session') {
      // "Decide now" from the panel: one fresh decision on that tab's page as it is.
      const request: unknown = changes[DECIDE_NOW_KEY]?.newValue;
      if (request && typeof request === 'object' && 'tabId' in request) {
        for (const [loop, tabId] of loops) if (tabId === request.tabId) loop.retarget();
      }
      return;
    }
    if (area !== 'local') return;
    if (PAUSED_KEY in changes) applyPaused(changes[PAUSED_KEY].newValue === true);
    // A new goal or brain is a new task: every connected page decides afresh.
    if (CONFIG_KEY in changes) for (const loop of loops.keys()) loop.retarget();
  });

  // ACTION: the toolbar icon is the stop button.
  browser.action.onClicked.addListener(async () => {
    await browser.storage.local.set({ [PAUSED_KEY]: !paused });
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_PORT) return;
    const tabId = port.sender?.tab?.id;
    console.log(`[agent] content connected from ${port.sender?.url ?? 'unknown'}`);

    const loop = new AgentLoop({
      decide: async (scene, signal) => {
        const config = await readConfig();
        if (!config.goal) return { ...nothingAfforded('unconfigured'), remaining: 'no goal configured' };
        return brainFor(config)({ scene, goal: config.goal, signal });
      },
      send: (message) => {
        try {
          port.postMessage(message);
        } catch {
          // The page left before onDisconnect stopped the loop; nothing to deliver to.
        }
      },
      record: (turn) => {
        const stamped = { ...turn, tabId };
        console.log(`[agent] turn ${turn.tick}: ${JSON.stringify(stamped)}`);
        appendTurn(stamped);
      },
      pending: (decision) => {
        if (decision) pending.set(loop, { ...decision, tabId });
        else pending.delete(loop);
        publishPending();
      },
    });
    loop.setPaused(paused);
    loops.set(loop, tabId);

    port.onMessage.addListener((message) => loop.ingest(message as ScenePatch));
    port.onDisconnect.addListener(() => {
      loop.stop();
      loops.delete(loop);
      if (pending.delete(loop)) publishPending();
      console.log('[agent] content disconnected');
    });
  });
});
