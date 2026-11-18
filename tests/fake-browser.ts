// A stand-in for the WebExtension `browser` global: storage areas that keep
// what they are given and announce each change, as the real ones do.
type Listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

function area(name: string, listeners: Set<Listener>) {
  const items = new Map<string, unknown>();
  return {
    async get(keys?: string | string[]): Promise<Record<string, unknown>> {
      const wanted = keys === undefined ? [...items.keys()] : typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(wanted.filter((key) => items.has(key)).map((key) => [key, items.get(key)]));
    },
    async set(next: Record<string, unknown>): Promise<void> {
      const changes = Object.fromEntries(
        Object.entries(next).map(([key, newValue]) => [key, { oldValue: items.get(key), newValue }]),
      );
      for (const [key, value] of Object.entries(next)) items.set(key, structuredClone(value));
      for (const listener of listeners) listener(structuredClone(changes), name);
    },
  };
}

export type FakeBrowser = ReturnType<typeof fakeBrowser>;

export function fakeBrowser() {
  const listeners = new Set<Listener>();
  return {
    storage: {
      local: area('local', listeners),
      session: area('session', listeners),
      onChanged: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
    runtime: {},
  };
}

/** Install a fresh fake as the global `browser`, the way WXT's auto-import resolves it. */
export function installFakeBrowser(): FakeBrowser {
  const fake = fakeBrowser();
  Object.assign(globalThis, { browser: fake });
  return fake;
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
