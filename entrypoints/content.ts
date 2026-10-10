// Content script: the perception half, and the hands.
//
// Up-edge: one Port, a full Scene on connect and on navigation, fast-json-patch
// deltas thereafter. Down-edge: apply the plan, then do nothing — the projector
// is already watching, so re-perception is automatic and the loop closes through
// the page rather than through a reply message.
//
// The Port is reopened whenever the background drops it (service-worker
// eviction, back/forward cache); see ContentPort.
import { SceneProjector } from '../utils/scene-projector';
import { applyPlan, didMove, summarize } from '../utils/reconciler';
import { ContentPort } from '../utils/content-port';
import { AGENT_PORT, type DownMessage } from '../utils/wire';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  // Every frame perceives and acts for itself; the background composes the
  // tab's frames into one Scene and routes each action to its frame.
  allFrames: true,
  main(ctx) {
    let projector: SceneProjector | undefined;

    const onPlan = (message: DownMessage): void => {
      const active = projector;
      if (!active) return;
      if (message.kind === 'idle') {
        console.log(`[agent] tick ${message.tick} idle: ${message.reason}`);
        return;
      }
      // A plan for a document we have navigated away from is discarded; the
      // snapshot for the new document is already on the wire.
      if (message.documentId !== active.current.documentId) {
        console.log(`[agent] tick ${message.tick} dropped: plan for a stale document`);
        return;
      }
      const results = applyPlan(message.actions, {
        resolve: (id) => active.elementFor(id),
        nodeOf: (id) => active.nodeOf(id),
      });
      console.log(`[agent] tick ${message.tick} remaining=${JSON.stringify(message.remaining)} -> ${summarize(results)}`);

      // The plan changed nothing, so the projector has nothing to report, so the
      // background would hear silence and conclude we are finished. We are not —
      // it stalled. Re-offer the same Scene and let it decide again; the tick
      // budget bounds how long it may keep stalling.
      if (!didMove(results)) {
        console.log(`[agent] tick ${message.tick} moved nothing — re-offering the scene`);
        channel.send(active.snapshot());
      }
    };

    const channel = new ContentPort({
      connect: () => {
        const port = browser.runtime.connect({ name: AGENT_PORT });
        // Reading lastError marks it handled; the disconnect itself is expected
        // (eviction, bfcache) and ContentPort recovers from it.
        port.onDisconnect.addListener(() => void browser.runtime.lastError);
        return port;
      },
      snapshot: () => projector?.snapshot(),
      onMessage: onPlan,
      isInvalid: () => ctx.isInvalid,
    });

    const perceive = (): void => {
      projector?.stop();
      projector = new SceneProjector({ root: document, emit: (patch) => channel.send(patch) });
      projector.scan();
      projector.start();
      projector.reflagModal();
      channel.send(projector.snapshot());
    };

    // SPA navigation is a new world: new documentId, new snapshot, fresh mirror.
    ctx.addEventListener(window, 'wxt:locationchange', () => perceive());
    // The back/forward cache closes the Port on the way in; let go of it first,
    // and reconnect with a fresh snapshot on the way out.
    ctx.addEventListener(window, 'pagehide', (event) => {
      if (event.persisted) channel.suspend();
    });
    ctx.addEventListener(window, 'pageshow', (event) => {
      if (event.persisted) channel.resume();
    });

    ctx.onInvalidated(() => {
      projector?.stop();
      channel.close();
    });

    channel.open();
    perceive();
  },
});
