// The toolbar popup: the Start affordance for one tab. It shows the shared
// config form, the agent's on/off switch for that tab, and Start, which saves
// the config, switches the agent on there, and asks for a decision now.
//
// The target tab is the active tab of the popup's window. `?tab=<id>` overrides
// it, so the page can be opened in a tab of its own and aimed at another one.
import '../../components/ui.css';
import { render } from 'preact';
import type { Browser } from 'wxt/browser';
import { ConfigForm } from '../../utils/config-form';
import { decideNow, setTabEnabled } from '../../utils/run-control';
import { RunSwitch, useRunState } from '../../utils/run-switch';
import { button, header, title } from '../../utils/ui';

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
        <button id="toggle-tab" type="button" class={button} disabled />
      </header>
      <p id="target" class={target}>
        No tab to run in.
      </p>
      <main id="config-slot" />
    </>
  );
}

function Popup({ tab, tabId }: { tab: Browser.tabs.Tab; tabId: number }) {
  const { onHere, paused } = useRunState(tabId);
  return (
    <>
      <header class={header}>
        <h1 class={title}>Aristodromos</h1>
        <RunSwitch tabId={tabId} onHere={onHere} paused={paused} />
      </header>
      <p id="target" class={target} title={tab.url ?? ''}>
        {tab.title || tab.url || `tab ${tabId}`}
      </p>
      <main id="config-slot">
        <ConfigForm
          submitLabel="Start"
          afterSave={async () => {
            await setTabEnabled(tabId, true);
            await decideNow(tabId);
          }}
        />
      </main>
    </>
  );
}

const tab = await targetTab();
render(tab?.id === undefined ? <NoTab /> : <Popup tab={tab} tabId={tab.id} />, document.body);
