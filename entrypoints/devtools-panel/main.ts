// The devtools panel: control and status for the agent, scoped to the inspected tab.
//
// Control and status go through `browser.storage.local`, the same state the
// background follows, so an evicted worker costs nothing here: writes wake it,
// and storage is the record. The live Scene is the one exception: it changes
// many times a second, so it streams over an INSPECT_PORT instead, and the
// panel folds it into its own replica exactly as the background does.
import '@andypf/json-viewer';
import {
  CONFIG_KEY,
  DECIDE_NOW_KEY,
  PAUSED_KEY,
  PENDING_KEY,
  SUGGESTED_SYSTEM_ONE,
  TURN_LOG_KEY,
  resolveConfig,
  type AgentConfig,
} from '../../utils/agent-config';
import type { PlanAction } from '../../utils/action-schema';
import { SceneStore } from '../../utils/scene-store';
import {
  INSPECT_PORT,
  type InspectMessage,
  type InspectRequest,
  type PendingDecision,
  type TurnRecord,
} from '../../utils/wire';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`devtools panel: #${id} missing from the page`);
  return found as T;
}

const ui = {
  runState: el<HTMLSpanElement>('run-state'),
  togglePause: el<HTMLButtonElement>('toggle-pause'),
  thinking: el<HTMLSpanElement>('thinking'),
  thinkingLabel: el<HTMLSpanElement>('thinking-label'),
  idle: el<HTMLSpanElement>('idle'),
  decideNow: el<HTMLButtonElement>('decide-now'),
  lastTurn: el<HTMLElement>('last-turn'),
  lastSatisfied: el<HTMLElement>('last-satisfied'),
  lastRemaining: el<HTMLElement>('last-remaining'),
  lastError: el<HTMLParagraphElement>('last-error'),
  form: el<HTMLFormElement>('config'),
  goal: el<HTMLTextAreaElement>('goal'),
  model: el<HTMLInputElement>('model'),
  baseURL: el<HTMLInputElement>('base-url'),
  soEnabled: el<HTMLInputElement>('so-enabled'),
  soFields: el<HTMLFieldSetElement>('so-fields'),
  soBaseURL: el<HTMLInputElement>('so-base-url'),
  soModel: el<HTMLInputElement>('so-model'),
  soThreshold: el<HTMLInputElement>('so-threshold'),
  saveNote: el<HTMLSpanElement>('save-note'),
  allTabs: el<HTMLInputElement>('all-tabs'),
  clearLog: el<HTMLButtonElement>('clear-log'),
  turnRows: el<HTMLTableSectionElement>('turn-rows'),
  noTurns: el<HTMLParagraphElement>('no-turns'),
  sceneMeta: el<HTMLSpanElement>('scene-meta'),
  sceneView: el<HTMLDivElement>('scene-view'),
  noScene: el<HTMLParagraphElement>('no-scene'),
};

const inspectedTabId = browser.devtools.inspectedWindow.tabId;
const dark = browser.devtools.panels.themeName === 'dark';
document.documentElement.dataset.theme = dark ? 'dark' : 'light';

let paused = false;
let turns: TurnRecord[] = [];
/** the inspected tab's most recent turn */
let lastHere: TurnRecord | undefined;
/** Unsaved edits win over a config change arriving from elsewhere. */
let dirty = false;

// ── run state ────────────────────────────────────────────────────────────────

function renderPaused(next: boolean): void {
  paused = next;
  ui.runState.textContent = paused ? 'Paused' : 'Running';
  ui.runState.dataset.state = paused ? 'paused' : 'running';
  ui.togglePause.textContent = paused ? 'Resume' : 'Pause';
  renderActivity();
}

ui.togglePause.addEventListener('click', () => {
  void browser.storage.local.set({ [PAUSED_KEY]: !paused });
});

// ── activity: deciding, or idle and why ──────────────────────────────────────

let pendingHere: PendingDecision | undefined;
let ticker: number | undefined;

/** Why the agent is not deciding on this tab, from its last turn; undefined while the page is moving. */
function idleReason(last: TurnRecord | undefined): string | undefined {
  if (!last || last.actions.length > 0) return undefined;
  if (last.error) return `error: ${last.error}`;
  if (last.done) return 'goal met';
  return last.remaining || 'nothing to act on';
}

function renderThinking(): void {
  if (!pendingHere) {
    window.clearInterval(ticker);
    ticker = undefined;
    ui.thinking.hidden = true;
    return;
  }
  const seconds = (Date.now() - pendingHere.startedAt) / 1000;
  ui.thinkingLabel.textContent = `Deciding #${pendingHere.tick} · ${seconds.toFixed(1)} s`;
  ui.thinking.hidden = false;
}

function renderActivity(): void {
  renderThinking();
  const reason = pendingHere || paused ? undefined : idleReason(lastHere);
  ui.idle.hidden = reason === undefined;
  ui.idle.textContent = reason === undefined ? '' : `Idle: ${reason}`;
  ui.idle.title = reason === undefined ? '' : `${reason} — waiting for the page to change`;
  ui.decideNow.disabled = paused || pendingHere !== undefined;
}

function setPending(stored: unknown): void {
  const all = Array.isArray(stored) ? (stored as PendingDecision[]) : [];
  pendingHere = all.find((decision) => decision.tabId === inspectedTabId);
  if (pendingHere && ticker === undefined) ticker = window.setInterval(renderThinking, 100);
  renderActivity();
}

ui.decideNow.addEventListener('click', () => {
  void browser.storage.session.set({ [DECIDE_NOW_KEY]: { tabId: inspectedTabId, at: Date.now() } });
});

// ── config form ──────────────────────────────────────────────────────────────

function syncSystemOneFields(): void {
  // A disabled fieldset skips validation and is left out of the saved config.
  ui.soFields.disabled = !ui.soEnabled.checked;
}

function fillForm(config: AgentConfig): void {
  ui.goal.value = config.goal;
  ui.model.value = config.model;
  ui.baseURL.value = config.baseURL;
  const systemOne = config.systemOne ?? SUGGESTED_SYSTEM_ONE;
  ui.soEnabled.checked = config.systemOne !== undefined;
  ui.soBaseURL.value = systemOne.baseURL;
  ui.soModel.value = systemOne.model;
  ui.soThreshold.value = String(systemOne.threshold);
  syncSystemOneFields();
  dirty = false;
}

function readForm(): AgentConfig {
  const config: AgentConfig = {
    goal: ui.goal.value.trim(),
    model: ui.model.value.trim(),
    baseURL: ui.baseURL.value.trim(),
  };
  if (ui.soEnabled.checked) {
    config.systemOne = {
      baseURL: ui.soBaseURL.value.trim(),
      model: ui.soModel.value.trim(),
      threshold: Number(ui.soThreshold.value),
    };
  }
  return config;
}

ui.soEnabled.addEventListener('change', syncSystemOneFields);
ui.form.addEventListener('input', () => {
  dirty = true;
  ui.saveNote.textContent = 'unsaved';
});
ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  void browser.storage.local.set({ [CONFIG_KEY]: readForm() }).then(() => {
    dirty = false;
    ui.saveNote.textContent = `saved ${new Date().toLocaleTimeString()}`;
  });
});

// ── turns ────────────────────────────────────────────────────────────────────

function describeAction(action: PlanAction): string {
  return action.kind === 'setState'
    ? `setState(${action.nodeId}, ${JSON.stringify(action.value)})`
    : `clickTrigger(${action.nodeId})`;
}

function describeVia(turn: TurnRecord): string {
  if (!turn.via) return '';
  return turn.confidence === undefined ? turn.via : `${turn.via} (${turn.confidence.toFixed(2)})`;
}

function cell(row: HTMLTableRowElement, text: string): void {
  row.insertCell().textContent = text;
}

function renderStatus(): void {
  const last = lastHere;
  ui.lastTurn.textContent = last
    ? `#${last.tick} at ${new Date(last.at).toLocaleTimeString()}, ${last.ms} ms — ${last.url}`
    : '—';
  ui.lastSatisfied.textContent = last?.satisfied || '—';
  ui.lastRemaining.textContent = last?.remaining || '—';
  ui.lastError.hidden = !last?.error;
  ui.lastError.textContent = last?.error ?? '';
}

function renderTurns(): void {
  const shown = ui.allTabs.checked ? turns : turns.filter((turn) => turn.tabId === inspectedTabId);
  const rows = shown.toReversed().map((turn) => {
    const row = document.createElement('tr');
    if (turn.error) row.className = 'error';
    cell(row, String(turn.tick));
    cell(row, new Date(turn.at).toLocaleTimeString());
    cell(row, String(turn.ms));
    cell(row, describeVia(turn));
    cell(row, turn.error ?? (turn.done ? 'goal met' : turn.remaining));
    cell(row, turn.actions.map(describeAction).join('\n'));
    row.title = turn.url;
    return row;
  });
  ui.turnRows.replaceChildren(...rows);
  ui.noTurns.hidden = rows.length > 0;
}

function setTurns(stored: unknown): void {
  turns = Array.isArray(stored) ? (stored as TurnRecord[]) : [];
  lastHere = turns.findLast((turn) => turn.tabId === inspectedTabId);
  renderStatus();
  renderTurns();
  renderActivity();
}

ui.allTabs.addEventListener('change', renderTurns);
ui.clearLog.addEventListener('click', () => {
  void browser.storage.local.set({ [TURN_LOG_KEY]: [] });
});

// ── wiring ───────────────────────────────────────────────────────────────────

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') {
    if (PENDING_KEY in changes) setPending(changes[PENDING_KEY].newValue);
    return;
  }
  if (area !== 'local') return;
  if (PAUSED_KEY in changes) renderPaused(changes[PAUSED_KEY].newValue === true);
  if (TURN_LOG_KEY in changes) setTurns(changes[TURN_LOG_KEY].newValue);
  if (CONFIG_KEY in changes && !dirty) fillForm(resolveConfig(changes[CONFIG_KEY].newValue));
});

void browser.storage.local.get([CONFIG_KEY, PAUSED_KEY, TURN_LOG_KEY]).then((stored) => {
  fillForm(resolveConfig(stored[CONFIG_KEY]));
  renderPaused(stored[PAUSED_KEY] === true);
  setTurns(stored[TURN_LOG_KEY]);
});

void browser.storage.session.get(PENDING_KEY).then((stored) => setPending(stored[PENDING_KEY]));

// ── live Scene ───────────────────────────────────────────────────────────────

const replica = new SceneStore();
const viewer = document.createElement('andypf-json-viewer');
Object.assign(viewer, {
  expanded: 1,
  indent: 2,
  theme: dark ? 'default-dark' : 'default-light',
  preserveExpanded: true,
  showDataTypes: false,
  showToolbar: true,
  showCopy: true,
  showSize: true,
});
ui.sceneView.append(viewer);

/** Patches arrive far faster than anyone reads; re-render at most every 200 ms. */
let renderQueued = false;

function renderScene(): void {
  renderQueued = false;
  const scene = replica.current;
  ui.noScene.hidden = scene !== null;
  ui.sceneView.hidden = scene === null;
  ui.sceneMeta.textContent = scene ? `${Object.keys(scene.nodes).length} nodes · ${scene.title || scene.url}` : '';
  if (scene) viewer.data = scene;
}

function inspect(): void {
  // The extension was reloaded: this panel is orphaned and can never reconnect.
  if (!browser.runtime?.id) return;
  const port = browser.runtime.connect({ name: INSPECT_PORT });
  port.onMessage.addListener((message) => {
    if (!replica.ingest(message as InspectMessage) || renderQueued) return;
    renderQueued = true;
    window.setTimeout(renderScene, 200);
  });
  port.onDisconnect.addListener(() => {
    // The worker was evicted. Connecting again restarts it, and the replica
    // keeps showing the last Scene until the new worker sends a fresh one.
    void browser.runtime.lastError;
    window.setTimeout(inspect, 500);
  });
  port.postMessage({ kind: 'inspect', tabId: inspectedTabId } satisfies InspectRequest);
}

renderScene();
inspect();
