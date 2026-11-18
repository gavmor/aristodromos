// The toolbar popup: the Start/Stop toggle for one tab. It shows the shared
// config form, whose button is Start (save the config, switch the agent on
// there, decide now) while the agent is off and Stop while it runs.
//
// The target tab is the active tab of the popup's window. `?tab=<id>` overrides
// it, so the page can be opened in a tab of its own and aimed at another one.
import '../../components/ui.css';
import { render } from 'preact';
import type { Browser } from 'wxt/browser';
import { RunState, TabForm, useRunning } from '../../utils/run-switch';
import { header, title } from '../../utils/ui';

const target = 'mt-1.5 truncate text-muted-foreground';

const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
// The popup's width; the page opened as a tab keeps it too.
document.body.classList.add('w-[420px]');

async function targetTab(): Promise<Browser.tabs.Tab | undefined> {
  const requested = Number(new URLSearchParams(location.search).get('tab'));
  if (Number.isInteger(requested) && requested > 0) return browser.tabs.get(requested);
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  return active;
}

function NoTab() {
  return (
    <>
      <header class={header}>
        <h1 class={title}>Aristodromos</h1>
        <span id="run-state" />
      </header>
      <p id="target" class={target}>
        No tab to run in.
      </p>
      <main id="config-slot" />
    </>
  );
}

function Popup({ tab, tabId }: { tab: Browser.tabs.Tab; tabId: number }) {
  const running = useRunning(tabId);
  return (
    <>
      <header class={header}>
        <h1 class={title}>Aristodromos</h1>
        <RunState running={running} />
      </header>
      <p id="target" class={target} title={tab.url ?? ''}>
        {tab.title || tab.url || `tab ${tabId}`}
      </p>
      <main id="config-slot">
        <TabForm tabId={tabId} running={running} />
      </main>
    </>
  );
}

const tab = await targetTab();
render(tab?.id === undefined ? <NoTab /> : <Popup tab={tab} tabId={tab.id} />, document.body);
