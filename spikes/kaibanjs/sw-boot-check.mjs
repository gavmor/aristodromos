// THROWAWAY SPIKE — does the built MV3 service-worker chunk actually BOOT?
//
// `wxt build` only proves the graph bundles. This evaluates .output/chrome-mv3/
// background.js inside a vm context that deliberately lacks `process`, `require`
// and every other Node global, with only the globals an MV3 service worker has.
//
// Run: node spikes/kaibanjs/sw-boot-check.mjs   (after `pnpm build`)
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const code = readFileSync(new URL('../../.output/chrome-mv3/background.js', import.meta.url), 'utf8');

const noop = () => {};
const listener = { addListener: noop, removeListener: noop };
const chrome = {
  runtime: { onMessage: listener, onInstalled: listener, getURL: (p) => p, id: 'spike' },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: listener },
  tabs: { sendMessage: async () => {}, onUpdated: listener },
  storage: { local: { get: async () => ({}), set: async () => {} } },
};

const sandbox = {
  console,
  fetch,
  Headers,
  Request,
  Response,
  AbortController,
  AbortSignal,
  ReadableStream,
  WritableStream,
  TransformStream,
  Blob,
  File,
  FormData,
  Event,
  EventTarget,
  CustomEvent,
  MessageChannel,
  performance,
  btoa,
  atob,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  crypto: globalThis.crypto,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  structuredClone,
  chrome,
  browser: chrome,
  self: undefined, // replaced below
  location: new URL('chrome-extension://spike/background.js'),
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const ctx = createContext(sandbox);
runInContext(code, ctx, { filename: 'background.js' });
console.log('SW BOOT OK — background.js evaluated with no Node globals present.');
