import { sendMessageWithAbort, isAbortError } from '../utils/messaging';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main(ctx) {
    // Derive initial value from the DOM: count all elements on the page
    let value = document.querySelectorAll('*').length;

    // Data-driven cancellation: abort stale in-flight ping each cycle
    let activePing: AbortController | null = null;

    // Listen for B2C messages from the background
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.direction === 'B2C' && message.type === 'PONG_BATCH') {
        if (message.payload.metadata instanceof Map) {
          console.log(
            'cs: received batch update —',
            message.payload.batch,
            '| metadata:',
            Object.fromEntries(message.payload.metadata),
          );
        }
        sendResponse({ status: 'ack' });
        return false; // synchronous response
      }
    });

    const intervalId = setInterval(async () => {
      if (ctx.isInvalidated) {
        clearInterval(intervalId);
        return;
      }

      // Cancel previous in-flight ping (data-driven cancellation)
      if (activePing) {
        console.log('cs: aborting stale ping');
        activePing.abort();
      }

      activePing = new AbortController();

      // Demonstrate structured clone: send a Map alongside the value
      const metadata = new Map<string, unknown>([
        ['elementCount', value],
        ['sentAt', new Date()],
      ]);

      try {
        const response = await sendMessageWithAbort<{ type: string; value: number }>(
          { type: 'ping', value, metadata },
          activePing.signal,
        );

        if (response.type === 'pong') {
          // Non-idempotent: Math.random() produces different results on each call
          value = response.value + Math.random();
          console.log('cs: sent →', response.value, '| next →', value);
        }
      } catch (err) {
        if (isAbortError(err)) {
          console.log('cs: ping safely aborted');
        } else {
          console.error('cs: ping-pong failed', err);
        }
      }
    }, 5000);

    ctx.onInvalidated(() => {
      console.log('cs: context invalidated — killing all active controllers');
      activePing?.abort();
      clearInterval(intervalId);
    });
  },
});
