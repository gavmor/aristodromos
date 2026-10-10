// The loop controller, with no browser API in it so it can be driven by tests.
//
// Shape of the cycle:
//   patches arrive -> quiet for `settleMs` -> decide -> emit plan -> the content
//   script actuates -> the page changes -> patches arrive -> ...
//
// The settle debounce is the only coordination in the system. It is not an ack
// and not a watermark: it is just "the page stopped moving, so this observation
// is worth reasoning about". A decision that lands on a stale Scene is harmless,
// because `setState` is convergent and the next observation is authoritative.
//
// Termination is structural, not negotiated: the brain either acts or declares
// the goal done. A done (or nothing-afforded) answer produces no page change,
// which produces no patches, which never re-arms the timer; the Scene is then
// settled, and only a page change, a new goal, or "Decide now" decides on it
// again. The tick budget exists only to bound a page that churns on its own.
import { TabScene, splitNodeId, type ComposedScene } from './tab-scene';
import { buildActionSchema, type PlanAction } from './action-schema';
import type { Decision } from './brain';
import type { Scene, ScenePatch } from './scene';
import type { DownMessage, PendingDecision, TurnRecord } from './wire';

export interface AgentLoopDeps {
  decide: (scene: Scene, signal: AbortSignal) => Promise<Decision>;
  /** to one frame of the tab, in that frame's own node ids and document */
  send: (frameId: number, message: DownMessage) => void;
  record: (turn: TurnRecord) => void;
  /** the decision now awaiting the brain, then `undefined` once it has answered or failed */
  pending?: (decision: PendingDecision | undefined) => void;
  /** quiet window that marks a Scene as settled */
  settleMs?: number;
  /** hard bound on decisions per document */
  maxTicks?: number;
  /** after a plan, how long the page may stay unchanged before the loop decides again */
  noEffectMs?: number;
  now?: () => number;
}

export class AgentLoop {
  private tab = new TabScene();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private noEffect: ReturnType<typeof setTimeout> | undefined;
  private inFlight: AbortController | undefined;
  private tick = 0;
  private opsSinceLastTurn = 0;
  private paused = false;
  private stopped = false;
  /** the tick budget ran out; only a new goal (`retarget`) lifts it */
  private exhausted = false;
  /** the current Scene was already decided on, came to nothing to do, and has not moved since */
  private settled = false;
  /** bumps on every Scene change, to tell whether a decision's Scene is still current */
  private revision = 0;

  constructor(private deps: AgentLoopDeps) {}

  /** Resuming decides on the Scene in hand, unless it was already decided idle. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.disarm();
    else this.rearm();
  }

  /**
   * The goal or brain changed: a new task on the same page. Fresh tick budget,
   * and a decision on the current Scene instead of waiting for the page to move.
   */
  retarget(): void {
    this.tick = 0;
    this.exhausted = false;
    this.settled = false;
    this.rearm();
  }

  /** Fold one frame's up-edge message in and re-arm the settle timer. */
  ingest(message: ScenePatch, frameId = 0): void {
    if (this.stopped) return;
    if (message.kind === 'snapshot') {
      // A frame on a new document is a new world: the budget starts over.
      if (this.tab.documentOf(frameId) !== message.scene.documentId) this.tick = 0;
      this.opsSinceLastTurn = 0;
    } else {
      this.opsSinceLastTurn += message.ops.length;
    }
    if (!this.tab.ingest(frameId, message)) return;
    this.changed();
  }

  /** A frame went away (navigated, removed, or its port closed); the page changed. */
  dropFrame(frameId: number): void {
    if (this.stopped || !this.tab.drop(frameId)) return;
    this.changed();
  }

  /** Each frame's own Scene, un-composed: what the brain decides on, frame by frame. */
  get frames(): [number, Scene][] {
    return this.tab.frames;
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
    clearTimeout(this.noEffect);
    this.inFlight?.abort();
  }

  private changed(): void {
    this.revision += 1;
    this.settled = this.tab.settled;
    // Keep the replica current even when not deciding, so a resume or a
    // retarget decides on what the page shows now.
    if (this.paused || this.exhausted || this.settled) return;
    this.arm();
  }

  private rearm(): void {
    if (this.stopped || this.exhausted || this.paused || this.settled || !this.tab.current) return;
    this.arm();
  }

  private arm(): void {
    this.disarm();
    this.timer = setTimeout(() => void this.settle(), this.deps.settleMs ?? 400);
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async settle(): Promise<void> {
    this.timer = undefined;
    const scene = this.tab.current;
    if (this.stopped || this.exhausted || this.paused || this.settled || !scene) return;
    // A decision is already running; the page moved under it. Let it finish —
    // its plan is still convergent — and re-evaluate on the next quiet window.
    if (this.inFlight) {
      this.arm();
      return;
    }

    if (this.tick >= (this.deps.maxTicks ?? 12)) {
      this.idle(scene, this.tick, 'tick budget exhausted');
      this.exhausted = true;
      return;
    }

    const tick = ++this.tick;
    const ops = this.opsSinceLastTurn;
    this.opsSinceLastTurn = 0;
    const started = (this.deps.now ?? Date.now)();
    const revision = this.revision;
    const afforded = buildActionSchema(scene);
    const controller = new AbortController();
    this.inFlight = controller;
    this.deps.pending?.({ tick, startedAt: started, documentId: scene.documentId, url: scene.url });

    let decision: Decision;
    let error: string | undefined;
    try {
      decision = await this.deps.decide(scene, controller.signal);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      decision = { decided: false, satisfied: '', remaining: '', actions: [] };
    } finally {
      this.inFlight = undefined;
      this.deps.pending?.(undefined);
    }

    // The page went away while the brain was thinking; its Port is closed, and
    // a plan for it has nowhere to go.
    if (this.stopped) return;

    this.deps.record({
      tick,
      at: started,
      documentId: scene.documentId,
      url: scene.url,
      opsSinceLastTurn: ops,
      afforded: { state: afforded?.stateIds ?? [], trigger: afforded?.triggerIds ?? [] },
      satisfied: decision.satisfied,
      remaining: decision.remaining,
      actions: decision.actions,
      done: decision.done,
      via: decision.via,
      confidence: decision.confidence,
      ms: (this.deps.now ?? Date.now)() - started,
      error,
    });

    if (decision.actions.length > 0) {
      for (const [frameId, actions] of byFrame(decision.actions)) {
        const frame = scene.frames[frameId];
        if (!frame) continue;
        this.deps.send(frameId, {
          kind: 'plan',
          documentId: frame.documentId,
          tick,
          satisfied: decision.satisfied,
          remaining: decision.remaining,
          actions,
        });
      }
      // A click can be applied and still change nothing: a dead link, a control
      // that ignores synthetic events. The page then stays silent, and silence
      // used to idle the loop for good. Decide again instead, within the budget.
      const sentAt = this.revision;
      clearTimeout(this.noEffect);
      this.noEffect = setTimeout(() => {
        if (this.revision === sentAt) this.rearm();
      }, this.deps.noEffectMs ?? 6000);
      return;
    }

    // Nothing to do on this Scene. Unless the page moved while the brain was
    // thinking, it is settled: deciding on it again would only repeat the answer.
    if (this.revision === revision) this.settled = true;
    this.idle(
      scene,
      tick,
      error ?? (decision.done ? 'goal met' : decision.remaining || (decision.decided ? 'no action chosen' : 'nothing afforded')),
    );
  }

  /** Every frame hears it, each about its own document: that is what its reconnect marker keys on. */
  private idle(scene: ComposedScene, tick: number, reason: string): void {
    for (const [frameId, frame] of Object.entries(scene.frames)) {
      this.deps.send(Number(frameId), { kind: 'idle', documentId: frame.documentId, tick, reason });
    }
  }
}

/** A tab-level plan, split into each frame's share, in that frame's own node ids. */
function byFrame(actions: PlanAction[]): Map<number, PlanAction[]> {
  const shares = new Map<number, PlanAction[]>();
  for (const action of actions) {
    const owner = splitNodeId(action.nodeId);
    if (!owner) continue;
    const share = shares.get(owner.frameId) ?? [];
    share.push({ ...action, nodeId: owner.nodeId });
    shares.set(owner.frameId, share);
  }
  return shares;
}
