// Content script: the perception half, and the hands.
//
// Up-edge: one Port, a full Scene on connect and on navigation, fast-json-patch
// deltas thereafter. Down-edge: apply the plan, then do nothing — the projector
// is already watching, so re-perception is automatic and the loop closes through
// the page rather than through a reply message.
import { SceneProjector } from '../utils/scene-projector';
import { applyPlan, summarize } from '../utils/reconciler';
import { AGENT_PORT, type DownMessage } from '../utils/wire';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main(ctx) {
    const port = browser.runtime.connect({ name: AGENT_PORT });
    let projector: SceneProjector | undefined;

    const perceive = (): void => {
      projector?.stop();
      projector = new SceneProjector({
        root: document,
        emit: (patch) => {
          if (ctx.isInvalid) return;
          port.postMessage(patch);
        },
      });
      projector.scan();
      projector.start();
      projector.reflagModal();
      port.postMessage(projector.snapshot());
    };

    port.onMessage.addListener((raw) => {
      const message = raw as DownMessage;
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
      console.log(`[agent] tick ${message.tick} ${JSON.stringify(message.reasoning)} -> ${summarize(results)}`);
    });

    // SPA navigation is a new world: new documentId, new snapshot, fresh mirror.
    ctx.addEventListener(window, 'wxt:locationchange', () => perceive());

    ctx.onInvalidated(() => {
      projector?.stop();
      port.disconnect();
    });

    perceive();
  },
});
