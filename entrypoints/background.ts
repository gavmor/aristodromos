// Background: the decision half.
//
// One AgentLoop per tab, deciding on the Scene composed from all of that tab's
// frames; each frame's content script has its own Port. The service worker
// holds no authoritative state — the Scene replica is rebuilt from the up-edge
// stream, so an MV3 eviction costs nothing but a reconnect.
//
// A loop only decides in a tab the user switched the agent on for (toolbar
// button or panel; the set lives in `browser.storage.session`) and while the
// global pause is off. Everywhere else it still perceives, so the panel can
// show the Scene, but never acts. Goal, brain and pause live in
// `browser.storage.local`; this worker follows `storage.onChanged`. A panel
// that inspects a tab also gets that tab's Scene stream, forwarded as it arrives.
import { createOllama } from 'ollama-ai-provider-v2';
import { AgentLoop } from '../utils/agent-loop';
import { aiSdkBrain, nothingAfforded, type Brain } from '../utils/brain';
import { JEV_SYSTEM_ONE } from '../utils/openinference-decision/protocols';
import { traceDecisions } from '../utils/openinference-decision/trace';
import { createGatedBrain, createSystemOneBrain } from '../utils/system-one-brain';
import { tracingFor } from '../utils/tracing';
import {
  CONFIG_KEY,
  DECIDE_NOW_KEY,
  ENABLED_TABS_KEY,
  PAUSED_KEY,
  PENDING_KEY,
  TURN_LOG_KEY,
  enabledTabsOf,
  resolveConfig,
  type AgentConfig,
} from '../utils/agent-config';
import type { Browser } from 'wxt/browser';
import type { ScenePatch } from '../utils/scene';
import {
  AGENT_PORT,
  INSPECT_PORT,
  type InspectMessage,
  type InspectRequest,
  type PendingDecision,
  type TurnRecord,
} from '../utils/wire';

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

/** The toolbar badge for one tab: blank when off, ▶ running, ⏸ on but paused. */
function setBadge(tabId: number, enabled: boolean, paused: boolean): void {
  // A tab can close between the decision and the call; its badge went with it.
  void browser.action.setBadgeText({ tabId, text: enabled ? (paused ? '⏸' : '▶') : '' }).catch(() => {});
  if (enabled) void browser.action.setBadgeBackgroundColor({ tabId, color: paused ? '#666666' : '#2e7d32' }).catch(() => {});
}

/**
 * Assemble the brain for one decision. The seam is a plain function, so the
 * loop cannot tell which side of it answered.
 *
 * With `systemOne` configured the cheap classifier decides first and the Ollama
 * brain becomes the confidence-gated fallback; without it, the Ollama brain is
 * the whole brain, exactly as before.
 *
 * With `tracing` set, both sides are traced through one provider, but not into
 * one trace: the System One call is a DECISION trace, and a fallback is an AI
 * SDK trace of its own. The AI SDK roots its spans in `context.active()`, which
 * a worker without a context manager cannot point at the gate.
 */
function brainFor(config: AgentConfig): Brain {
  const tracing = tracingFor(config.tracing);
  const ollama = createOllama({ baseURL: config.baseURL });
  const slow = aiSdkBrain(ollama.chat(config.model), tracing?.telemetry);
  if (!config.systemOne) return slow;

  return createGatedBrain({
    fast: createSystemOneBrain({
      baseURL: config.systemOne.baseURL,
      model: config.systemOne.model,
      fetchImpl: tracing && traceDecisions({ tracer: tracing.tracer, protocol: JEV_SYSTEM_ONE }),
    }),
    slow,
    threshold: config.systemOne.threshold,
  });
}

export default defineBackground(() => {
  // Paused, and on nowhere, until storage says otherwise: a worker woken after
  // eviction must not act on a page the user had paused or never switched on.
  let paused = true;
  /** The tabs the user switched the agent on for. It runs nowhere else. */
  let enabled = new Set<number>();
  const runs = (tabId: number): boolean => !paused && enabled.has(tabId);
  /** One agent per tab: its loop, and the port of each frame composing it. */
  interface TabAgent {
    loop: AgentLoop;
    ports: Map<number, Browser.runtime.Port>;
  }
  const tabs = new Map<number, TabAgent>();
  const pending = new Map<number, PendingDecision>();
  /** DevTools panels watching a tab's Scene, with the tab each one inspects */
  const inspectors = new Map<Browser.runtime.Port, number>();

  const toInspectors = (tabId: number, message: InspectMessage): void => {
    for (const [port, watched] of inspectors) {
      if (watched !== tabId) continue;
      try {
        port.postMessage(message);
      } catch {
        inspectors.delete(port); // closed before its onDisconnect reached us
      }
    }
  };

  const publishPending = (): void => {
    void browser.storage.session.set({ [PENDING_KEY]: [...pending.values()] });
  };
  // A fresh worker has no loops, so nothing it inherited can still be in flight.
  publishPending();

  const agentFor = (tabId: number): TabAgent => {
    const existing = tabs.get(tabId);
    if (existing) return existing;
    const ports = new Map<number, Browser.runtime.Port>();
    const loop = new AgentLoop({
      decide: async (scene, signal) => {
        const config = await readConfig();
        if (!config.goal) return { ...nothingAfforded('unconfigured'), remaining: 'no goal configured' };
        return brainFor(config)({ scene, goal: config.goal, signal });
      },
      send: (frameId, message) => {
        try {
          ports.get(frameId)?.postMessage(message);
        } catch {
          // The frame left before its onDisconnect reached us; nothing to deliver to.
        }
      },
      record: (turn) => {
        const stamped = { ...turn, tabId };
        console.log(`[agent] turn ${turn.tick}: ${JSON.stringify(stamped)}`);
        appendTurn(stamped);
      },
      pending: (decision) => {
        if (decision) pending.set(tabId, { ...decision, tabId });
        else pending.delete(tabId);
        publishPending();
      },
    });
    loop.setPaused(!runs(tabId));
    const agent = { loop, ports };
    tabs.set(tabId, agent);
    return agent;
  };

  /** Bring every loop and badge in line with `paused` and `enabled`. */
  const applyRunState = (): void => {
    for (const [tabId, { loop }] of tabs) loop.setPaused(!runs(tabId));
    for (const tabId of enabled) setBadge(tabId, true, paused);
  };

  const setEnabled = (next: Set<number>): void => {
    for (const tabId of enabled) if (!next.has(tabId)) setBadge(tabId, false, paused);
    enabled = next;
    applyRunState();
  };

  const writeEnabled = (next: Set<number>): Promise<void> =>
    browser.storage.session.set({ [ENABLED_TABS_KEY]: [...next] });

  // The global badge of earlier versions; every badge is per tab now.
  void browser.action.setBadgeText({ text: '' });
  void Promise.all([browser.storage.local.get(PAUSED_KEY), browser.storage.session.get(ENABLED_TABS_KEY)]).then(
    ([local, session]) => {
      paused = local[PAUSED_KEY] === true;
      setEnabled(enabledTabsOf(session[ENABLED_TABS_KEY]));
    },
  );

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session') {
      if (ENABLED_TABS_KEY in changes) setEnabled(enabledTabsOf(changes[ENABLED_TABS_KEY].newValue));
      // "Decide now" from the panel: one fresh decision on that tab's page as it is.
      const request: unknown = changes[DECIDE_NOW_KEY]?.newValue;
      if (request && typeof request === 'object' && 'tabId' in request) {
        if (typeof request.tabId === 'number') tabs.get(request.tabId)?.loop.retarget();
      }
      return;
    }
    if (area !== 'local') return;
    if (PAUSED_KEY in changes) {
      paused = changes[PAUSED_KEY].newValue === true;
      applyRunState();
      console.log(`[agent] ${paused ? 'paused' : 'resumed'}`);
    }
    // A new goal or brain is a new task: every connected page decides afresh.
    if (CONFIG_KEY in changes) for (const { loop } of tabs.values()) loop.retarget();
  });

  // ACTION: the toolbar icon switches the agent on or off for the tab it is clicked in.
  browser.action.onClicked.addListener(async (tab) => {
    if (tab.id === undefined) return;
    const next = new Set(enabled);
    if (!next.delete(tab.id)) next.add(tab.id);
    await writeEnabled(next);
  });

  // A closed tab's id is gone for good; drop it from the switched-on set.
  browser.tabs.onRemoved.addListener((tabId) => {
    if (!enabled.has(tabId)) return;
    const next = new Set(enabled);
    next.delete(tabId);
    void writeEnabled(next);
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === INSPECT_PORT) {
      port.onMessage.addListener((raw) => {
        const request = raw as InspectRequest;
        inspectors.set(port, request.tabId);
        // Every frame's current Scene, for the panel to compose its own replica from.
        for (const [frameId, scene] of tabs.get(request.tabId)?.loop.frames ?? []) {
          port.postMessage({ frameId, message: { kind: 'snapshot', scene } } satisfies InspectMessage);
        }
      });
      port.onDisconnect.addListener(() => inspectors.delete(port));
      return;
    }
    if (port.name !== AGENT_PORT) return;
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined) return;
    const frameId = port.sender?.frameId ?? 0;
    console.log(`[agent] frame ${frameId} of tab ${tabId} connected from ${port.sender?.url ?? 'unknown'}`);

    const agent = agentFor(tabId);
    // A navigated frame keeps its frame id; its new content script replaces the old port.
    agent.ports.set(frameId, port);

    port.onMessage.addListener((raw) => {
      const message = raw as ScenePatch;
      agent.loop.ingest(message, frameId);
      toInspectors(tabId, { frameId, message });
    });
    port.onDisconnect.addListener(() => {
      if (agent.ports.get(frameId) !== port) return; // already replaced by a newer document
      agent.ports.delete(frameId);
      agent.loop.dropFrame(frameId);
      toInspectors(tabId, { frameId, gone: true });
      console.log(`[agent] frame ${frameId} of tab ${tabId} disconnected`);
      if (agent.ports.size > 0) return;
      agent.loop.stop();
      tabs.delete(tabId);
      if (pending.delete(tabId)) publishPending();
    });
  });
});
