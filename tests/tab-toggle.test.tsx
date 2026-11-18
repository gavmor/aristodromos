// One Start/Stop toggle per tab: Start saves the config, switches the agent on
// for that tab and asks for a decision now; Stop switches it off. Nothing else
// stands between Start and a running agent, not even a pause an older version
// left in storage.
import { render } from 'preact';
import { beforeEach, expect, it } from 'vitest';
import { CONFIG_KEY, DECIDE_NOW_KEY, ENABLED_TABS_KEY } from '../utils/agent-config';
import { RunState, TabForm, useRunning } from '../utils/run-switch';
import { type FakeBrowser, installFakeBrowser, settle } from './fake-browser';

const TAB = 7;
const toggle = () => document.getElementById('submit-config') as HTMLButtonElement;
const state = () => document.getElementById('run-state')?.dataset.state;
const session = async (key: string) => (await fake.storage.session.get(key))[key];

/** What the popup and the panel render: the state in the header, the form as the toggle. */
function Page() {
  const running = useRunning(TAB);
  return (
    <>
      <RunState running={running} />
      <TabForm tabId={TAB} running={running} />
    </>
  );
}

let fake: FakeBrowser;

beforeEach(async () => {
  fake = installFakeBrowser();
  await fake.storage.local.set({
    [CONFIG_KEY]: { goal: 'Reach the end.', provider: 'ollama', model: 'm', baseURL: 'http://127.0.0.1:1/api' },
    paused: true,
  });
  await fake.storage.session.set({ [ENABLED_TABS_KEY]: [3] });
  render(null, document.body);
  render(<Page />, document.body);
  await settle();
});

it('starts and stops the agent on its own tab, and only there', async () => {
  expect(state()).toBe('off');
  expect(toggle().textContent).toBe('Start');

  toggle().click();
  await settle();
  expect(await session(ENABLED_TABS_KEY)).toEqual([3, TAB]);
  expect(await session(DECIDE_NOW_KEY)).toMatchObject({ tabId: TAB });
  expect(state()).toBe('running');
  expect(toggle().textContent).toBe('Stop');

  toggle().click();
  await settle();
  expect(await session(ENABLED_TABS_KEY)).toEqual([3]);
  expect(state()).toBe('off');
  expect(toggle().textContent).toBe('Start');
});
