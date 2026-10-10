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
// Termination is structural, not negotiated: an empty plan produces no page
// change, which produces no patches, which never re-arms the timer. The tick
// budget exists only to bound a page that churns on its own.
import { SceneStore } from './scene-store';
import { buildActionSchema } from './action-schema';
import type { Decision } from './brain';
import type { Scene, ScenePatch } from './scene';
import type { DownMessage, TurnRecord } from './wire';

export interface AgentLoopDeps {
  decide: (scene: Scene, signal: AbortSignal) => Promise<Decision>;
  send: (message: DownMessage) => void;
  record: (turn: TurnRecord) => void;
  /** quiet window that marks a Scene as settled */
  settleMs?: number;
  /** hard bound on decisions per connection */
  maxTicks?: number;
  now?: () => number;
}

export class AgentLoop {
  private store = new SceneStore();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: AbortController | undefined;
  private tick = 0;
  private opsSinceLastTurn = 0;
  private paused = false;
  private stopped = false;

  constructor(private deps: AgentLoopDeps) {}

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.disarm();
  }

  /** Fold an up-edge message in and re-arm the settle timer. */
  ingest(message: ScenePatch): void {
    if (this.stopped) return;
    if (message.kind === 'snapshot') {
      // A new document resets the derived view AND the budget: it is a new world.
      if (this.store.current?.documentId !== message.scene.documentId) this.tick = 0;
      this.opsSinceLastTurn = 0;
    } else {
      this.opsSinceLastTurn += message.ops.length;
    }
    if (!this.store.ingest(message)) return;
    if (this.paused) return;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
    this.inFlight?.abort();
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
    const scene = this.store.current;
    if (this.stopped || this.paused || !scene) return;
    // A decision is already running; the page moved under it. Let it finish —
    // its plan is still convergent — and re-evaluate on the next quiet window.
    if (this.inFlight) {
      this.arm();
      return;
    }

    if (this.tick >= (this.deps.maxTicks ?? 12)) {
      this.deps.send({ kind: 'idle', documentId: scene.documentId, tick: this.tick, reason: 'tick budget exhausted' });
      this.stopped = true;
      return;
    }

    const tick = ++this.tick;
    const ops = this.opsSinceLastTurn;
    this.opsSinceLastTurn = 0;
    const started = (this.deps.now ?? Date.now)();
    const afforded = buildActionSchema(scene);
    const controller = new AbortController();
    this.inFlight = controller;

    let decision: Decision;
    let error: string | undefined;
    try {
      decision = await this.deps.decide(scene, controller.signal);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      decision = { decided: false, satisfied: '', remaining: '', actions: [] };
    } finally {
      this.inFlight = undefined;
    }

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
      ms: (this.deps.now ?? Date.now)() - started,
      error,
    });

    if (decision.actions.length > 0) {
      this.deps.send({
        kind: 'plan',
        documentId: scene.documentId,
        tick,
        satisfied: decision.satisfied,
        remaining: decision.remaining,
        actions: decision.actions,
      });
      return;
    }

    this.deps.send({
      kind: 'idle',
      documentId: scene.documentId,
      tick,
      reason: error ?? (decision.decided ? decision.remaining || 'goal satisfied by the current scene' : 'nothing afforded'),
    });
  }
}
