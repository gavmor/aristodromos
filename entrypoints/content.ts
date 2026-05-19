export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main(ctx) {
    const intervalId = setInterval(() => {
      if (ctx.isInvalidated) {
        clearInterval(intervalId);
        return;
      }
      console.log('hello world (from content script)');
    }, 5000);

    ctx.onInvalidated(() => {
      clearInterval(intervalId);
    });
  },
});
