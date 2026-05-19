import { buildAXTree, distillAXTreeToSchema } from '../utils/dom-snapshot';
import { sendMessageWithAbort, isAbortError } from '../utils/messaging';
import { applyOperationalTransformAsync } from '../utils/ot-executor';
import { executeOT } from '../utils/content-handler';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main(ctx) {
    let activeUIController: AbortController | null = null;

    // PROCESSOR: handle EXECUTE_OT from background
    browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      if (message.direction === 'B2C' && message.type === 'EXECUTE_OT') {
        executeOT(message.payload, applyOperationalTransformAsync, ctx.signal)
          .then(sendResponse);
        return true;
      }
    });

    // EMITTER: capture scene every 5s
    ctx.setInterval(async () => {
      if (ctx.isInvalid) return;

      if (activeUIController) {
        activeUIController.abort();
      }
      activeUIController = new AbortController();

      const combinedSignal = AbortSignal.any
        ? AbortSignal.any([activeUIController.signal, ctx.signal])
        : activeUIController.signal;

      const { axNode } = buildAXTree();
      const { scene, schema } = distillAXTreeToSchema(axNode);

      try {
        const response = await sendMessageWithAbort<{ status: string }>(
          { direction: 'C2B', type: 'SCENE_UPDATED', payload: { scene, schema } },
          combinedSignal,
        );
        if (response?.status === 'success') {
          console.log('[Content] Background acknowledged scene update.');
        }
      } catch (err) {
        if (!isAbortError(err)) {
          console.error('[Content] Scene update failed:', err);
        }
      }
    }, 5000);

    ctx.onInvalidated(() => {
      activeUIController?.abort();
    });
  },
});
