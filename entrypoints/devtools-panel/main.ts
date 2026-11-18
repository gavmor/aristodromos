// The devtools panel: control and status for the agent, scoped to the inspected tab.
//
// Control and status go through `browser.storage.local`, the same state the
// background follows, so an evicted worker costs nothing here: writes wake it,
// and storage is the record. The live Scene is the one exception: it changes
// many times a second, so it streams over an INSPECT_PORT instead, and the
// panel folds it into its own replica exactly as the background does.
import '@andypf/json-viewer';
import { type PendingDecision, type PlanAction, TabScene, type TurnRecord } from '@gavmor/skene/core';
import { trainingJsonl } from '@gavmor/skene/training';
import { ENABLED_TABS_KEY, enabledTabsOf, PAUSED_KEY, PENDING_KEY, TURN_LOG_KEY } from '../../utils/agent-config';
import { mountConfigForm } from '../../utils/config-form';
import { INSPECT_PORT, type InspectMessage, type InspectRequest } from '../../utils/extension-protocol';
import { decideNow, setTabEnabled } from '../../utils/run-control';
import { type LoggedTurn, turnsOf, verifiedRowsOf } from '../../utils/turn-log';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`devtools panel: #${id} missing from the page`);
  return found as T;
}

const ui = {
  runState: el<HTMLSpanElement>('run-state'),
  togglePause: el<HTMLButtonElement>('toggle-pause'),
  toggleTab: el<HTMLButtonElement>('toggle-tab'),
  thinking: el<HTMLSpanElement>('thinking'),
  thinkingLabel: el<HTMLSpanElement>('thinking-label'),
  idle: el<HTMLSpanElement>('idle'),
  decideNow: el<HTMLButtonElement>('decide-now'),
  lastTurn: el<HTMLElement>('last-turn'),
  lastSatisfied: el<HTMLElement>('last-satisfied'),
  lastRemaining: el<HTMLElement>('last-remaining'),
  lastError: el<HTMLParagraphElement>('last-error'),
  allTabs: el<HTMLInputElement>('all-tabs'),
  clearLog: el<HTMLButtonElement>('clear-log'),
  exportRun: el<HTMLButtonElement>('export-run'),
  exportNote: el<HTMLParagraphElement>('export-note'),
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
/** the agent is switched on for the inspected tab */
let onHere = false;
let turns: LoggedTurn[] = [];
/** the inspected tab's most recent turn */
let lastHere: TurnRecord | undefined;

// The goal/brain form: shared with the popup, bound to storage, tab-agnostic.
mountConfigForm(el('config-slot'), { submitLabel: 'Save and run', brainOpen: true });

// ── run state ────────────────────────────────────────────────────────────────

function renderRunState(): void {
  const state = !onHere ? 'off' : paused ? 'paused' : 'running';
  ui.runState.textContent = { off: 'Off', paused: 'Paused', running: 'Running' }[state];
  ui.runState.dataset.state = state;
  ui.toggleTab.textContent = onHere ? 'Turn off for this tab' : 'Turn on for this tab';
  ui.togglePause.textContent = paused ? 'Resume all' : 'Pause all';
  renderActivity();
}

function renderPaused(next: boolean): void {
  paused = next;
  renderRunState();
}

function setEnabledTabs(stored: unknown): void {
  onHere = enabledTabsOf(stored).has(inspectedTabId);
  renderRunState();
}

ui.togglePause.addEventListener('click', () => {
  void browser.storage.local.set({ [PAUSED_KEY]: !paused });
});

ui.toggleTab.addEventListener('click', () => {
  void setTabEnabled(inspectedTabId);
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
  const reason = pendingHere || paused || !onHere ? undefined : idleReason(lastHere);
  ui.idle.hidden = reason === undefined;
  ui.idle.textContent = reason === undefined ? '' : `Idle: ${reason}`;
  ui.idle.title = reason === undefined ? '' : `${reason} — waiting for the page to change`;
  ui.decideNow.disabled = !onHere || paused || pendingHere !== undefined;
}

function setPending(stored: unknown): void {
  const all = Array.isArray(stored) ? (stored as PendingDecision[]) : [];
  pendingHere = all.find((decision) => decision.tabId === inspectedTabId);
  if (pendingHere && ticker === undefined) ticker = window.setInterval(renderThinking, 100);
  renderActivity();
}

ui.decideNow.addEventListener('click', () => {
  void decideNow(inspectedTabId);
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
  turns = turnsOf(stored);
  lastHere = turns.findLast((turn) => turn.tabId === inspectedTabId);
  renderStatus();
  renderTurns();
  renderActivity();
}

ui.allTabs.addEventListener('change', renderTurns);
// The person watching is the verifier: only they can say the run reached its
// goal. Clear the log before a run so this tab's turns are that run alone.
ui.exportRun.addEventListener('click', () => {
  const runId = `tab${inspectedTabId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const rows = verifiedRowsOf(turns, inspectedTabId, runId);
  ui.exportNote.hidden = false;
  if (rows.length === 0) {
    ui.exportNote.textContent =
      'No training rows: only System One turns whose plan moved the page count, and this tab has none.';
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([trainingJsonl(rows)], { type: 'application/jsonl' }));
  link.download = `${runId}.jsonl`;
  link.click();
  // Revoked once the download has had its turn to read it.
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  ui.exportNote.textContent = `Exported ${rows.length} training rows as ${link.download}.`;
});

ui.clearLog.addEventListener('click', () => {
  ui.exportNote.hidden = true;
  void browser.storage.local.set({ [TURN_LOG_KEY]: [] });
});

// ── wiring ───────────────────────────────────────────────────────────────────

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') {
    if (PENDING_KEY in changes) setPending(changes[PENDING_KEY].newValue);
    if (ENABLED_TABS_KEY in changes) setEnabledTabs(changes[ENABLED_TABS_KEY].newValue);
    return;
  }
  if (area !== 'local') return;
  if (PAUSED_KEY in changes) renderPaused(changes[PAUSED_KEY].newValue === true);
  if (TURN_LOG_KEY in changes) setTurns(changes[TURN_LOG_KEY].newValue);
});

void browser.storage.local.get([PAUSED_KEY, TURN_LOG_KEY]).then((stored) => {
  renderPaused(stored[PAUSED_KEY] === true);
  setTurns(stored[TURN_LOG_KEY]);
});

void browser.storage.session.get([PENDING_KEY, ENABLED_TABS_KEY]).then((stored) => {
  setPending(stored[PENDING_KEY]);
  setEnabledTabs(stored[ENABLED_TABS_KEY]);
});

// ── live Scene ───────────────────────────────────────────────────────────────

let replica = new TabScene();
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
  const frameCount = scene ? Object.keys(scene.frames).length : 0;
  ui.sceneMeta.textContent = scene
    ? `${Object.keys(scene.nodes).length} nodes${frameCount > 1 ? ` in ${frameCount} frames` : ''} · ${scene.title || scene.url}`
    : '';
  if (scene) viewer.data = scene;
}

function inspect(): void {
  // The extension was reloaded: this panel is orphaned and can never reconnect.
  if (!browser.runtime?.id) return;
  const port = browser.runtime.connect({ name: INSPECT_PORT });
  // The old replica keeps showing until this connection's first word, which
  // replaces it: frames that vanished while disconnected must not linger.
  let fresh = true;
  port.onMessage.addListener((raw) => {
    if (fresh) {
      replica = new TabScene();
      fresh = false;
    }
    const message = raw as InspectMessage;
    const changed =
      'gone' in message ? replica.drop(message.frameId) : replica.ingest(message.frameId, message.message);
    if (!changed || renderQueued) return;
    renderQueued = true;
    window.setTimeout(renderScene, 200);
  });
  port.onDisconnect.addListener(() => {
    // The worker was evicted. Connecting again restarts it.
    void browser.runtime.lastError;
    window.setTimeout(inspect, 500);
  });
  port.postMessage({ kind: 'inspect', tabId: inspectedTabId } satisfies InspectRequest);
}

renderScene();
inspect();
