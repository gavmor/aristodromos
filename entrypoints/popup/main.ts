// The toolbar popup: the Start affordance for one tab. It shows the shared
// config form, the agent's on/off switch for that tab, and Start, which saves
// the config, switches the agent on there, and asks for a decision now.
//
// The target tab is the active tab of the popup's window. `?tab=<id>` overrides
// it, so the page can be opened in a tab of its own and aimed at another one.
import type { Browser } from 'wxt/browser';
import { ENABLED_TABS_KEY, enabledTabsOf, PAUSED_KEY } from '../../utils/agent-config';
import { mountConfigForm } from '../../utils/config-form';
import { decideNow, setTabEnabled } from '../../utils/run-control';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`popup: #${id} missing from the page`);
  return found as T;
}

const ui = {
  runState: el<HTMLSpanElement>('run-state'),
  toggleTab: el<HTMLButtonElement>('toggle-tab'),
  target: el<HTMLParagraphElement>('target'),
  slot: el<HTMLElement>('config-slot'),
};

const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = dark ? 'dark' : 'light';

async function targetTab(): Promise<Browser.tabs.Tab | undefined> {
  const requested = Number(new URLSearchParams(location.search).get('tab'));
  if (Number.isInteger(requested) && requested > 0) return browser.tabs.get(requested);
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  return active;
}

const tab = await targetTab();
const tabId = tab?.id;

if (tabId === undefined) {
  ui.target.textContent = 'No tab to run in.';
  ui.toggleTab.disabled = true;
} else {
  ui.target.textContent = tab?.title || tab?.url || `tab ${tabId}`;
  ui.target.title = tab?.url ?? '';

  let paused = false;
  let onHere = false;
  const render = (): void => {
    const state = !onHere ? 'off' : paused ? 'paused' : 'running';
    ui.runState.textContent = { off: 'Off', paused: 'Paused', running: 'Running' }[state];
    ui.runState.dataset.state = state;
    ui.toggleTab.textContent = onHere ? 'Turn off for this tab' : 'Turn on for this tab';
  };

  ui.toggleTab.addEventListener('click', () => {
    void setTabEnabled(tabId);
  });

  mountConfigForm(ui.slot, {
    submitLabel: 'Start',
    afterSave: async () => {
      await setTabEnabled(tabId, true);
      await decideNow(tabId);
    },
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && ENABLED_TABS_KEY in changes) {
      onHere = enabledTabsOf(changes[ENABLED_TABS_KEY].newValue).has(tabId);
    } else if (area === 'local' && PAUSED_KEY in changes) {
      paused = changes[PAUSED_KEY].newValue === true;
    } else return;
    render();
  });
  const [local, session] = await Promise.all([
    browser.storage.local.get(PAUSED_KEY),
    browser.storage.session.get(ENABLED_TABS_KEY),
  ]);
  paused = local[PAUSED_KEY] === true;
  onHere = enabledTabsOf(session[ENABLED_TABS_KEY]).has(tabId);
  render();
}
