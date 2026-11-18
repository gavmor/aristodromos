// The agent's state on one tab and its on/off switch there, shared by the
// popup and the panel headers.
import { ENABLED_TABS_KEY, enabledTabsOf, PAUSED_KEY } from './agent-config';
import { setTabEnabled } from './run-control';
import { useStorage } from './use-storage';

/** Whether the agent is on for `tabId`, and the global pause, as stored. */
export function useRunState(tabId: number): { onHere: boolean; paused: boolean } {
  const paused = useStorage('local', PAUSED_KEY).value === true;
  const onHere = enabledTabsOf(useStorage('session', ENABLED_TABS_KEY).value).has(tabId);
  return { onHere, paused };
}

export function RunSwitch({ tabId, onHere, paused }: { tabId: number; onHere: boolean; paused: boolean }) {
  const state = !onHere ? 'off' : paused ? 'paused' : 'running';
  return (
    <>
      <span id="run-state" class="pill" data-state={state}>
        {{ off: 'Off', paused: 'Paused', running: 'Running' }[state]}
      </span>
      <button id="toggle-tab" type="button" onClick={() => void setTabEnabled(tabId)}>
        {onHere ? 'Turn off for this tab' : 'Turn on for this tab'}
      </button>
    </>
  );
}
