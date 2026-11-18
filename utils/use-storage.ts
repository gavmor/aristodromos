// The UI's one state convention: Preact hooks. Every screen is a thin view of
// `browser.storage`, which is already the reactive record (it announces each
// change), so a component needs only "the stored value, re-rendered on change":
// `useState` + `useEffect` say that with nothing beyond Preact itself, where
// signals would add a second store mirroring the first.
import { useLayoutEffect, useState } from 'preact/hooks';

/** One reading of a storage key: a new object per change, so effects keyed on it run for each one. */
export interface Stored {
  /** `undefined` until the first read lands, and whenever nothing is stored */
  value: unknown;
}

/**
 * What `browser.storage[area]` holds under `key`, kept current: the component
 * re-renders on every change there, even one that stores an equal value.
 */
export function useStorage(area: 'local' | 'session', key: string): Stored {
  const [stored, setStored] = useState<Stored>({ value: undefined });
  // Layout effect: subscribed as soon as the component is in the DOM, not a frame later.
  useLayoutEffect(() => {
    let changed = false;
    const listener = (changes: Record<string, { newValue?: unknown }>, changedArea: string): void => {
      if (changedArea !== area || !(key in changes)) return;
      changed = true;
      setStored({ value: changes[key].newValue });
    };
    browser.storage.onChanged.addListener(listener);
    void browser.storage[area].get(key).then((items: Record<string, unknown>) => {
      // A change that arrived first is newer than this read.
      if (!changed) setStored({ value: items[key] });
    });
    return () => browser.storage.onChanged.removeListener(listener);
  }, [area, key]);
  return stored;
}
