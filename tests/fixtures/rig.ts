// A whole agent in one jsdom page: SceneProjector -> AgentLoop -> brain ->
// handlePlan -> the page, closed through the DOM exactly as the extension
// closes it. Only the transports are replaced: the Port is a function call.
//
// The brain a test supplies is a function of the Scene alone, as a real one is;
// whatever it "remembers" must be read back off the page.
import { AgentLoop, type AgentLoopDeps } from '../../utils/agent-loop';
import { handlePlan } from '../../utils/plan-handler';
import { SceneProjector } from '../../utils/scene-projector';
import type { Decision } from '../../utils/decision';
import type { Scene, SceneNode } from '../../utils/scene';
import type { TurnRecord } from '../../utils/wire';

export type Mind = (scene: Scene) => Decision | Promise<Decision>;

export interface Rig {
  loop: AgentLoop;
  turns: TurnRecord[];
  /** the page's current Scene, as the projector holds it */
  scene: () => Scene;
  /** replace the document: a new projector, so a new documentId, as on SPA navigation */
  navigate: (html: string) => void;
  /** resolves once `until` holds; rejects with the turn log if it never does */
  waitFor: (until: () => boolean, what: string) => Promise<void>;
  /** resolves after `ms` with no new turn, i.e. the loop has gone quiet */
  quiet: (ms?: number) => Promise<void>;
  stop: () => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function mount(html: string, mind: Mind, options: Partial<AgentLoopDeps> = {}): Rig {
  const turns: TurnRecord[] = [];
  let projector: SceneProjector;

  const loop = new AgentLoop({
    decide: async (scene) => mind(scene),
    send: (_frameId, message) => handlePlan(projector, message, (patch) => loop.ingest(patch, 0)),
    record: (turn) => turns.push(turn),
    settleMs: 5,
    noEffectMs: 60,
    ...options,
  });

  const perceive = (): void => {
    projector?.stop();
    projector = new SceneProjector({
      root: document,
      emit: (patch) => loop.ingest(patch, 0),
      schedule: (cb) => void setTimeout(cb, 0),
    });
    projector.scan();
    projector.start();
    projector.reflagModal();
    loop.ingest(projector.snapshot(), 0);
  };

  document.body.innerHTML = html;
  perceive();

  return {
    loop,
    turns,
    scene: () => projector.current,
    navigate: (next) => {
      document.body.innerHTML = next;
      perceive();
    },
    waitFor: async (until, what) => {
      for (let waited = 0; waited < 3000; waited += 5) {
        if (until()) return;
        await sleep(5);
      }
      throw new Error(`timed out waiting for ${what}; turns: ${JSON.stringify(turns.map((t) => [t.tick, t.actions, t.done]))}`);
    },
    quiet: async (ms = 200) => {
      for (let seen = -1; seen !== turns.length; ) {
        seen = turns.length;
        await sleep(ms);
      }
    },
    stop: () => {
      loop.stop();
      projector.stop();
      document.body.innerHTML = '';
    },
  };
}

/** The reachable node with this accessible name; the brain's way of "reading the screen". */
export const named = (scene: Scene, name: string): SceneNode | undefined =>
  Object.values(scene.nodes).find((n) => n.name === name && n.category !== 'structure' && n.perception.visible);

/** Visible prose anywhere on the page, for a brain that judges "is it done?" from what the page says. */
export const pageSays = (scene: Scene, text: string): boolean =>
  Object.values(scene.nodes).some((n) => 'text' in n && typeof n.text === 'string' && n.text.includes(text));

export const set = (nodeId: string, value: string | boolean): Decision => ({
  decided: true,
  satisfied: '',
  remaining: '',
  actions: [{ kind: 'setState', nodeId, value }],
});
export const click = (nodeId: string): Decision => ({
  decided: true,
  satisfied: '',
  remaining: '',
  actions: [{ kind: 'clickTrigger', nodeId }],
});
export const finished: Decision = { decided: true, done: true, satisfied: 'done', remaining: '', actions: [] };
