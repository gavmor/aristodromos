// One browser, the built extension loaded into it, and the handful of things
// the e2e scenario needs from it. The scenario (run.ts) is the same for every
// browser; only how each one is driven differs.
//
//   Chromium: Playwright loads the unpacked build, opens the popup page in a
//             tab of its own, and reads the turn log through the service worker.
//   Firefox:  Playwright cannot load extensions into Firefox, so geckodriver
//             installs the release zip as a temporary add-on, and the popup page
//             is opened as a tab (a fixed moz-extension UUID).
//
// Either way the agent is configured and started the way a user does it: in
// the popup's form, with Start. Nothing here writes the extension's storage.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import type { AgentConfig } from '../utils/agent-config.ts';

/** E2E_HEADED=1 shows the browser window, so you can watch the agent work. */
const HEADED = process.env.E2E_HEADED === '1';

export interface Harness {
  openPage(url: string): Promise<void>;
  /**
   * Start the agent on the tab at `url` the way a user does: open the popup
   * for that tab, fill in the form, press Start, and wait for it to run.
   */
  start(url: string, config: AgentConfig): Promise<void>;
  /** a global the fixture page sets on itself */
  pageValue(name: string): Promise<unknown>;
  turnLog(): Promise<unknown[]>;
  screenshot(file: string): Promise<void>;
  /** what the browser lets us read of the extension's console: see each harness */
  consoleLines(): Promise<string[]>;
  close(): Promise<void>;
}

/** One thing a user does in the popup's form. */
type FormStep = { fill: string; value: string } | { check: string; on: boolean } | { click: string };

/** What a user does in the popup to start `config`, ending with Start. */
function startSteps(config: AgentConfig): FormStep[] {
  const { systemOne, tracing } = config;
  return [
    { fill: '#goal', value: config.goal },
    { click: '#brain > summary' },
    { fill: '#model', value: config.model },
    { fill: '#base-url', value: config.baseURL },
    { check: '#so-enabled', on: systemOne !== undefined },
    ...(systemOne
      ? [
          { fill: '#so-base-url', value: systemOne.baseURL },
          { fill: '#so-model', value: systemOne.model },
          { fill: '#so-threshold', value: String(systemOne.threshold) },
        ]
      : []),
    { check: '#tr-enabled', on: tracing !== undefined },
    ...(tracing
      ? [
          { fill: '#tr-endpoint', value: tracing.endpoint },
          { fill: '#tr-project', value: tracing.project },
        ]
      : []),
    { click: '#submit-config' },
  ];
}

/** The form has rendered the stored config: typing before that would be overwritten. */
const FORM_READY = `(document.querySelector('#model')?.value ?? '') !== ''`;
/** Start took: the popup shows the agent running on its tab. */
const RUNNING = `document.querySelector('#run-state')?.dataset.state === 'running'`;

/** Declared, not imported: only ever runs inside the extension, never in Node. */
declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
  tabs: { query(filter: { url: string }): Promise<{ id?: number }[]> };
};

export async function chromiumHarness(extensionDir: string): Promise<Harness> {
  const profile = await mkdtemp(path.join(tmpdir(), 'aristodromos-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: !HEADED,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-sandbox'],
  });
  // MV3 service workers can be asleep; wait until one shows up.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  console.log(`[e2e] extension service worker up: ${worker.url()}`);
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (!text.startsWith('[agent]')) return;
    consoleLines.push(text);
    console.log(`  page ${text}`);
  });

  return {
    consoleLines: async () => consoleLines,
    openPage: async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },
    start: async (url, config) => {
      const [tabId] = await worker.evaluate(
        async (at) => (await chrome.tabs.query({ url: at })).flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
        url,
      );
      if (tabId === undefined) throw new Error(`no tab at ${url}`);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html?tab=${tabId}`);
      await popup.waitForFunction(FORM_READY);
      for (const step of startSteps(config)) {
        if ('fill' in step) await popup.fill(step.fill, step.value);
        else if ('check' in step) await popup.setChecked(step.check, step.on);
        else await popup.click(step.click);
      }
      await popup.waitForFunction(RUNNING);
      // A real popup closes once it has done its job.
      await popup.close();
    },
    pageValue: (name) => page.evaluate((key) => (window as unknown as Record<string, unknown>)[key], name),
    turnLog: () =>
      worker.evaluate(async () => {
        const stored = await chrome.storage.local.get('turnLog');
        return (stored.turnLog ?? []) as unknown[];
      }),
    screenshot: async (file) => {
      await page.screenshot({ path: file, fullPage: true });
    },
    close: () => context.close(),
  };
}

const FIREFOX_ID = 'aristodromos@gavmor.github.io';
/** pinned so the extension's own pages have a known address */
const FIREFOX_UUID = '7d2c1f0e-6a39-4f7e-9d3b-2a1e0c5b8f41';

export async function firefoxHarness(zip: string): Promise<Harness> {
  const options = new firefox.Options()
    .setBinary(process.env.FIREFOX_PATH ?? '/usr/bin/firefox')
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }));
  if (!HEADED) options.addArguments('-headless');
  const driver = (await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    // opening a moz-extension:// tab needs the privileged (chrome) context
    .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access'))
    .build()) as firefox.Driver;
  await driver.installAddon(zip, true);
  console.log(`[e2e] add-on installed in Firefox from ${path.basename(zip)}`);

  // The extension's side: its popup page, opened as a tab. Marionette will
  // not navigate to moz-extension:// itself, so the browser window opens it.
  await driver.get('about:blank');
  const pageTab = await driver.getWindowHandle();
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(
    `const w = Services.wm.getMostRecentWindow('navigator:browser');
     w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
    `moz-extension://${FIREFOX_UUID}/popup.html`,
  );
  await driver.setContext(firefox.Context.CONTENT);
  let extensionTab: string | undefined;
  for (let tries = 0; !extensionTab && tries < 50; tries++) {
    extensionTab = (await driver.getAllWindowHandles()).find((handle) => handle !== pageTab);
    if (!extensionTab) await driver.sleep(100);
  }
  if (!extensionTab) throw new Error('the extension page never opened');
  const tab = extensionTab;
  // The new tab starts at about:blank; wait for the extension page itself.
  await driver.switchTo().window(tab);
  await driver.wait(
    async () =>
      (await driver.executeScript('return typeof browser === "object" && document.readyState')) === 'complete',
    10_000,
    'the extension page never loaded',
  );
  await driver.switchTo().window(pageTab);

  /** run `body` (an async function body using `browser` and `arg`) inside the extension */
  const inExtension = async <T>(body: string, arg?: unknown): Promise<T> => {
    await driver.switchTo().window(tab);
    const result = (await driver.executeAsyncScript(
      `const done = arguments[arguments.length - 1];
       const arg = arguments[0];
       (async () => { ${body} })().then((value) => done({ value }), (err) => done({ error: String(err) }));`,
      arg,
    )) as { value?: T; error?: string };
    await driver.switchTo().window(pageTab);
    if (result.error) throw new Error(`in the extension: ${result.error}`);
    return result.value as T;
  };

  return {
    // Firefox: the extension's errors (Services.console, readable from the
    // privileged context). Its console.log output is not exposed to WebDriver,
    // so the `[agent]` lines are Chromium-only.
    consoleLines: async () => {
      await driver.setContext(firefox.Context.CHROME);
      try {
        return (await driver.executeScript(
          `return Services.console.getMessageArray()
             .map((m) => m.message ?? String(m))
             .filter((line) => line.includes('moz-extension://') && /error|exception/i.test(line));`,
        )) as string[];
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
    },
    openPage: (url) => driver.get(url),
    start: async (url, config) => {
      // tabs.query's url filter is a match pattern, and Firefox's carry no port.
      const tabId = await inExtension<number | undefined>(
        'return (await browser.tabs.query({})).find((t) => t.url === arg)?.id;',
        url,
      );
      if (tabId === undefined) throw new Error(`no tab at ${url}`);
      await driver.switchTo().window(tab);
      try {
        await driver.executeScript(`location.search = '?tab=${tabId}';`);
        await driver.wait(
          async () =>
            Boolean(await driver.executeScript(`return location.search === '?tab=${tabId}' && ${FORM_READY};`)),
          10_000,
          'the popup never showed the stored config',
        );
        for (const step of startSteps(config)) {
          if ('fill' in step) {
            const input = await driver.findElement(By.css(step.fill));
            await input.clear();
            await input.sendKeys(step.value);
          } else if ('check' in step) {
            const box = await driver.findElement(By.css(step.check));
            if ((await box.isSelected()) !== step.on) await box.click();
          } else await driver.findElement(By.css(step.click)).click();
        }
        await driver.wait(
          async () => Boolean(await driver.executeScript(`return ${RUNNING};`)),
          10_000,
          'Start never took',
        );
      } finally {
        await driver.switchTo().window(pageTab);
      }
    },
    pageValue: (name) => driver.executeScript(`return window[arguments[0]];`, name),
    turnLog: () => inExtension<unknown[]>(`return (await browser.storage.local.get('turnLog')).turnLog ?? [];`),
    screenshot: async (file) => {
      await writeFile(file, Buffer.from(await driver.takeScreenshot(), 'base64'));
    },
    close: () => driver.quit(),
  };
}
