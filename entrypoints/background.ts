export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    console.log('hello world (from onInstalled)', { reason: details.reason });
  });

  setInterval(() => {
    console.log('hello world (from background interval)');
  }, 5000);
});
