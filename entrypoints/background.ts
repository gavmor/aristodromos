// Background: the decision half.
//
// One AgentLoop per connected content script. The service worker holds no
// authoritative state — the Scene replica is rebuilt from the up-edge stream, so
// an MV3 eviction costs nothing but a reconnect.
import { createOllama } from 'ollama-ai-provider-v2';
import { AgentLoop } from '../utils/agent-loop';
import { decide } from '../utils/brain';
import { CONFIG_KEY, DEFAULT_CONFIG, TURN_LOG_KEY, type AgentConfig } from '../utils/agent-config';
import type { ScenePatch } from '../utils/scene';
import { AGENT_PORT, type TurnRecord } from '../utils/wire';

const TURN_LOG_CAP = 200;

/** Serialise the read-modify-write; two ports can settle in the same tick. */
let logWrites: Promise<void> = Promise.resolve();

async function readConfig(): Promise<AgentConfig> {
  const stored = await browser.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(stored[CONFIG_KEY] as Partial<AgentConfig> | undefined) };
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

export default defineBackground(() => {
  let paused = false;
  const loops = new Set<AgentLoop>();

  void setBadge(paused);

  // ACTION: the toolbar icon is the stop button.
  browser.action.onClicked.addListener(async () => {
    paused = !paused;
    for (const loop of loops) loop.setPaused(paused);
    await setBadge(paused);
    console.log(`[agent] ${paused ? 'paused' : 'resumed'}`);
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_PORT) return;
    console.log(`[agent] content connected from ${port.sender?.url ?? 'unknown'}`);

    const loop = new AgentLoop({
      decide: async (scene, signal) => {
        const config = await readConfig();
        if (!config.goal) return { decided: false, reasoning: '', actions: [] };
        const ollama = createOllama({ baseURL: config.baseURL });
        return decide({ scene, goal: config.goal, model: ollama.chat(config.model), signal });
      },
      send: (message) => port.postMessage(message),
      record: (turn) => {
        console.log(`[agent] turn ${turn.tick}: ${JSON.stringify(turn)}`);
        appendTurn(turn);
      },
    });
    loop.setPaused(paused);
    loops.add(loop);

    port.onMessage.addListener((message) => loop.ingest(message as ScenePatch));
    port.onDisconnect.addListener(() => {
      loop.stop();
      loops.delete(loop);
      console.log('[agent] content disconnected');
    });
  });
});
