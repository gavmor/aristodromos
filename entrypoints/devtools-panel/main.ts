// The devtools panel: control and status for the agent, scoped to the inspected tab.
//
// Everything goes through `browser.storage.local`, the same state the background
// follows. The panel never talks to the service worker directly, so an evicted
// worker costs nothing here: writes wake it, and storage is the record.
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
import type { PendingDecision, TurnRecord } from '../../utils/wire';

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
};

const inspectedTabId = browser.devtools.inspectedWindow.tabId;
document.documentElement.dataset.theme = browser.devtools.panels.themeName === 'dark' ? 'dark' : 'light';

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
