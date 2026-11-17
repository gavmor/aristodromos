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
import { handlePlan } from '../utils/plan-handler';
import { ContentPort } from '../utils/content-port';
import { AGENT_PORT } from '../utils/extension-protocol';
import type { DownMessage } from '../utils/wire';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  // Every frame perceives and acts for itself; the background composes the
  // tab's frames into one Scene and routes each action to its frame.
  allFrames: true,
  main(ctx) {
    let projector: SceneProjector | undefined;

    const onPlan = (message: DownMessage): void => {
      if (projector) handlePlan(projector, message, (patch) => channel.send(patch), (line) => console.log(line));
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
