// The agent's state on one tab, and the one control for it: the shared config
// form whose button is Start while the agent is off there and Stop while it
// runs. Shared by the popup and the panel.
import { ENABLED_TABS_KEY, enabledTabsOf } from './agent-config';
import { ConfigForm } from './config-form';
import { decideNow, setTabEnabled } from './run-control';
import { useStorage } from './use-storage';

const pill = 'rounded-full border px-2 py-px font-semibold';
const PILL = {
  off: `${pill} border-border text-muted-foreground`,
  running: `${pill} border-running bg-running text-background`,
};

/** Whether the agent is switched on for `tabId`, as stored. */
export function useRunning(tabId: number): boolean {
  return enabledTabsOf(useStorage('session', ENABLED_TABS_KEY).value).has(tabId);
}

export function RunState({ running }: { running: boolean }) {
  const state = running ? 'running' : 'off';
  return (
    <span id="run-state" class={PILL[state]} data-state={state}>
      {running ? 'Running' : 'Off'}
    </span>
  );
}

/** The config form as the toggle for `tabId`: Start saves, switches on and decides now; Stop switches off. */
export function TabForm({ tabId, running, brainOpen }: { tabId: number; running: boolean; brainOpen?: boolean }) {
  return (
    <ConfigForm
      brainOpen={brainOpen}
      running={running}
      onStart={async () => {
        await setTabEnabled(tabId, true);
        await decideNow(tabId);
      }}
      onStop={() => setTabEnabled(tabId, false)}
    />
  );
}
