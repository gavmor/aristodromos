// Switching the agent on or off for one tab, and asking it to decide now: the
// writes the panel and the popup share. The background follows both from
// `browser.storage.session`.
import { DECIDE_NOW_KEY, ENABLED_TABS_KEY, enabledTabsOf } from './agent-config';

/** Switch the agent on (`true`), off (`false`), or to the other state (omitted) for `tabId`. */
export async function setTabEnabled(tabId: number, on?: boolean): Promise<void> {
  const stored = await browser.storage.session.get(ENABLED_TABS_KEY);
  const next = enabledTabsOf(stored[ENABLED_TABS_KEY]);
  if (on ?? !next.has(tabId)) next.add(tabId);
  else next.delete(tabId);
  await browser.storage.session.set({ [ENABLED_TABS_KEY]: [...next] });
}

/** One fresh decision on `tabId`'s page as it is now. */
export function decideNow(tabId: number): Promise<void> {
  return browser.storage.session.set({ [DECIDE_NOW_KEY]: { tabId, at: Date.now() } });
}
