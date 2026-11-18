// The devtools panel: control and status for the agent, scoped to the inspected tab.
//
// Control and status go through `browser.storage.local`, the same state the
// background follows, so an evicted worker costs nothing here: writes wake it,
// and storage is the record. The live Scene is the one exception: it changes
// many times a second, so it streams over an INSPECT_PORT instead, and the
// panel folds it into its own replica exactly as the background does.
import '../../components/ui.css';
import '@andypf/json-viewer';
import { type PendingDecision, type PlanAction, TabScene, type TurnRecord } from '@gavmor/skene/core';
import { trainingJsonl } from '@gavmor/skene/training';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PAUSED_KEY, PENDING_KEY, TURN_LOG_KEY } from '../../utils/agent-config';
import { ConfigForm } from '../../utils/config-form';
import { INSPECT_PORT, type InspectMessage, type InspectRequest } from '../../utils/extension-protocol';
import { decideNow } from '../../utils/run-control';
import { RunSwitch, useRunState } from '../../utils/run-switch';
import { type LoggedTurn, turnsOf, verifiedRowsOf } from '../../utils/turn-log';
import { button, header, heading, inline, section, title } from '../../utils/ui';
import { useStorage } from '../../utils/use-storage';

const cell = 'border-b border-border px-1.5 py-0.5 text-left align-top';
const th = `${cell} font-semibold text-muted-foreground`;
/** #, time, ms, via: short, kept on one line */
const cellShort = `${cell} whitespace-nowrap`;
const cellText = `${cell} whitespace-pre-wrap wrap-anywhere`;
const cellCode = `${cell} whitespace-pre-wrap break-words font-mono`;

const inspectedTabId = browser.devtools.inspectedWindow.tabId;
const dark = browser.devtools.panels.themeName === 'dark';
document.documentElement.dataset.theme = dark ? 'dark' : 'light';

// ── activity: deciding, or idle and why ──────────────────────────────────────

/** Why the agent is not deciding on this tab, from its last turn; undefined while the page is moving. */
function idleReason(last: TurnRecord | undefined): string | undefined {
  if (!last || last.actions.length > 0) return undefined;
  if (last.error) return `error: ${last.error}`;
  if (last.done) return 'goal met';
  return last.remaining || 'nothing to act on';
}

/** The pending decision's elapsed time, ticking every 100 ms while it lasts. */
function Thinking({ pending }: { pending: PendingDecision | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!pending) return;
    const ticker = window.setInterval(() => tick((n) => n + 1), 100);
    return () => window.clearInterval(ticker);
  }, [pending]);
  const seconds = pending ? (Date.now() - pending.startedAt) / 1000 : 0;
  return (
    <span
      id="thinking"
      class="inline-flex items-center gap-1.5 text-primary tabular-nums"
      role="status"
      hidden={!pending}
    >
      <span
        class="size-3 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:[animation-duration:2.4s]"
        aria-hidden="true"
      />
      <span id="thinking-label">{pending ? `Deciding #${pending.tick} · ${seconds.toFixed(1)} s` : ''}</span>
    </span>
  );
}

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

function Status({ last }: { last: TurnRecord | undefined }) {
  return (
    <section id="status" class={section}>
      <h2 class={heading}>This tab</h2>
      <dl class="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground">
        <dt>Last turn</dt>
        <dd id="last-turn">
          {last ? `#${last.tick} at ${new Date(last.at).toLocaleTimeString()}, ${last.ms} ms — ${last.url}` : '—'}
        </dd>
        <dt>Satisfied</dt>
        <dd id="last-satisfied">{last?.satisfied || '—'}</dd>
        <dt>Remaining</dt>
        <dd id="last-remaining">{last?.remaining || '—'}</dd>
      </dl>
      <p id="last-error" class="text-destructive" hidden={!last?.error}>
        {last?.error ?? ''}
      </p>
    </section>
  );
}

function Turns({ turns }: { turns: LoggedTurn[] }) {
  const [allTabs, setAllTabs] = useState(false);
  const [exportNote, setExportNote] = useState<string | undefined>();
  const shown = allTabs ? turns : turns.filter((turn) => turn.tabId === inspectedTabId);

  // The person watching is the verifier: only they can say the run reached its
  // goal. Clear the log before a run so this tab's turns are that run alone.
  const exportRun = (): void => {
    const runId = `tab${inspectedTabId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const rows = verifiedRowsOf(turns, inspectedTabId, runId);
    if (rows.length === 0) {
      setExportNote('No training rows: only System One turns whose plan moved the page count, and this tab has none.');
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([trainingJsonl(rows)], { type: 'application/jsonl' }));
    link.download = `${runId}.jsonl`;
    link.click();
    // Revoked once the download has had its turn to read it.
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    setExportNote(`Exported ${rows.length} training rows as ${link.download}.`);
  };

  const clearLog = (): void => {
    setExportNote(undefined);
    void browser.storage.local.set({ [TURN_LOG_KEY]: [] });
  };

  return (
    <section id="turns" class={section}>
      <div class="flex items-center gap-3">
        <h2 class={`${heading} flex-1`}>Turns</h2>
        <label class={inline}>
          <input
            id="all-tabs"
            type="checkbox"
            checked={allTabs}
            onChange={(event) => setAllTabs(event.currentTarget.checked)}
          />{' '}
          all tabs
        </label>
        <button
          class={button}
          id="export-run"
          type="button"
          title="This tab's logged run reached its goal: download its System One answers as Jeff training rows (JSONL)"
          onClick={exportRun}
        >
          Run succeeded: export
        </button>
        <button id="clear-log" type="button" class={button} onClick={clearLog}>
          Clear log
        </button>
      </div>
      <p id="export-note" class="text-muted-foreground" hidden={exportNote === undefined}>
        {exportNote ?? ''}
      </p>
      <table class="mt-1.5 w-full border-collapse">
        <thead>
          <tr>
            <th class={th}>#</th>
            <th class={th}>Time</th>
            <th class={th}>ms</th>
            <th class={th}>Via</th>
            <th class={th}>Remaining</th>
            <th class={th}>Actions</th>
          </tr>
        </thead>
        <tbody id="turn-rows">
          {shown.toReversed().map((turn) => (
            <tr
              key={`${turn.tabId}-${turn.at}-${turn.tick}`}
              class={turn.error ? 'text-destructive' : undefined}
              title={turn.url}
            >
              <td class={cellShort}>{String(turn.tick)}</td>
              <td class={cellShort}>{new Date(turn.at).toLocaleTimeString()}</td>
              <td class={cellShort}>{String(turn.ms)}</td>
              <td class={cellShort}>{describeVia(turn)}</td>
              <td class={cellText}>{turn.error ?? (turn.done ? 'goal met' : turn.remaining)}</td>
              <td class={cellCode}>{turn.actions.map(describeAction).join('\n')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p id="no-turns" class="text-muted-foreground" hidden={shown.length > 0}>
        No turns yet.
      </p>
    </section>
  );
}

// ── live Scene ───────────────────────────────────────────────────────────────

type Scene = NonNullable<TabScene['current']>;

/** The inspected tab's Scene, replicated from the INSPECT_PORT stream. */
function useLiveScene(): Scene | null {
  const [scene, setScene] = useState<Scene | null>(null);
  useEffect(() => {
    let replica = new TabScene();
    let stopped = false;
    let port: Browser.runtime.Port | undefined;
    /** Patches arrive far faster than anyone reads; re-render at most every 200 ms. */
    let renderQueued = false;
    const show = (): void => {
      renderQueued = false;
      setScene(replica.current);
    };
    const inspect = (): void => {
      // The extension was reloaded: this panel is orphaned and can never reconnect.
      if (stopped || !browser.runtime?.id) return;
      port = browser.runtime.connect({ name: INSPECT_PORT });
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
        window.setTimeout(show, 200);
      });
      port.onDisconnect.addListener(() => {
        // The worker was evicted. Connecting again restarts it.
        void browser.runtime.lastError;
        window.setTimeout(inspect, 500);
      });
      port.postMessage({ kind: 'inspect', tabId: inspectedTabId } satisfies InspectRequest);
    };
    inspect();
    return () => {
      stopped = true;
      port?.disconnect();
    };
  }, []);
  return scene;
}

function SceneView() {
  const scene = useLiveScene();
  // While there is no Scene the viewer is hidden and keeps its last one.
  const lastShown = useRef<Scene | null>(null);
  if (scene) lastShown.current = scene;
  const frameCount = scene ? Object.keys(scene.frames).length : 0;
  return (
    <details id="scene" class="py-2.5" open>
      <summary class="flex cursor-pointer items-baseline gap-3">
        <h2 class={heading}>Scene</h2>
        <span id="scene-meta" class="truncate text-muted-foreground">
          {scene
            ? `${Object.keys(scene.nodes).length} nodes${frameCount > 1 ? ` in ${frameCount} frames` : ''} · ${scene.title || scene.url}`
            : ''}
        </span>
      </summary>
      <div id="scene-view" class="mt-1.5" hidden={scene === null}>
        <andypf-json-viewer
          expanded={1}
          indent={2}
          theme={dark ? 'default-dark' : 'default-light'}
          preserveExpanded
          showDataTypes={false}
          showToolbar
          showCopy
          showSize
          data={lastShown.current}
        />
      </div>
      <p id="no-scene" class="text-muted-foreground" hidden={scene !== null}>
        No Scene for this tab yet. If the extension was just reloaded, reload the page.
      </p>
    </details>
  );
}

// ── the panel ────────────────────────────────────────────────────────────────

function Panel() {
  /** whether the agent is switched on for the inspected tab, and the global pause */
  const { onHere, paused } = useRunState(inspectedTabId);
  const turns = turnsOf(useStorage('local', TURN_LOG_KEY).value);
  const pendingStored = useStorage('session', PENDING_KEY).value;
  const pending = Array.isArray(pendingStored)
    ? (pendingStored as PendingDecision[]).find((decision) => decision.tabId === inspectedTabId)
    : undefined;
  /** the inspected tab's most recent turn */
  const lastHere = turns.findLast((turn) => turn.tabId === inspectedTabId);

  const reason = pending || paused || !onHere ? undefined : idleReason(lastHere);

  return (
    <>
      <header class={header}>
        <h1 class={title}>Aristodromos</h1>
        <RunSwitch tabId={inspectedTabId} onHere={onHere} paused={paused} />
        <button
          class={button}
          id="toggle-pause"
          type="button"
          title="Pause or resume the agent in every tab it is on for"
          onClick={() => void browser.storage.local.set({ [PAUSED_KEY]: !paused })}
        >
          {paused ? 'Resume all' : 'Pause all'}
        </button>
        <div class="ml-auto flex min-w-0 items-center gap-2">
          <Thinking pending={pending} />
          <span
            id="idle"
            class="truncate text-muted-foreground"
            role="status"
            hidden={reason === undefined}
            title={reason === undefined ? '' : `${reason} — waiting for the page to change`}
          >
            {reason === undefined ? '' : `Idle: ${reason}`}
          </span>
          <button
            class={button}
            id="decide-now"
            type="button"
            title="One fresh decision on this tab's page as it is now"
            disabled={!onHere || paused || pending !== undefined}
            onClick={() => void decideNow(inspectedTabId)}
          >
            Decide now
          </button>
        </div>
      </header>

      <Status last={lastHere} />

      <section id="config-slot" class={section}>
        <h2 class={heading}>Goal and brain</h2>
        {/* The goal/brain form: shared with the popup, bound to storage, tab-agnostic. */}
        <ConfigForm submitLabel="Save and run" brainOpen />
      </section>

      <Turns turns={turns} />

      <SceneView />
    </>
  );
}

render(<Panel />, document.body);
