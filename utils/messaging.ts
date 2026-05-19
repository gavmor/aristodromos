/** AbortController-wrapped sendMessage for WXT v0.20+ (raw API, no polyfill) */
export function sendMessageWithAbort<T>(
  message: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException('Aborted', 'AbortError'));
    }

    browser.runtime.sendMessage(message).then(resolve).catch(reject);

    signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

export function isAbortError(err: unknown): err is DOMException {
  return err instanceof DOMException && err.name === 'AbortError';
}
