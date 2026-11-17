// One browser, the built extension loaded into it, and the handful of things
// the e2e scenario needs from it. The scenario (run.ts) is the same for every
// browser; only how each one is driven differs.
//
//   Chromium: Playwright loads the unpacked build and reaches the extension
//             through its service worker.
//   Firefox:  Playwright cannot load extensions into Firefox, so geckodriver
//             installs the release zip as a temporary add-on, and the extension
//             is reached from one of its own pages (a fixed moz-extension UUID).
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

export interface Harness {
  /** set the stored config and empty the turn log */
  configure(config: Record<string, unknown>): Promise<void>;
  openPage(url: string): Promise<void>;
  /** switch the agent on for every tab at `url`, as the toolbar button would */
  enableTabsAt(url: string): Promise<void>;
  /** a global the fixture page sets on itself */
  pageValue(name: string): Promise<unknown>;
  turnLog(): Promise<unknown[]>;
  screenshot(file: string): Promise<void>;
  /** what the browser lets us read of the extension's console: see each harness */
  consoleLines(): Promise<string[]>;
  close(): Promise<void>;
}

/** Declared, not imported: only ever runs inside the extension, never in Node. */
declare const chrome: {
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
    session: { set(items: Record<string, unknown>): Promise<void> };
  };
  tabs: { query(filter: { url: string }): Promise<{ id?: number }[]> };
};

export async function chromiumHarness(extensionDir: string): Promise<Harness> {
  const profile = await mkdtemp(path.join(tmpdir(), 'aristodromos-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true,
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
    configure: (config) =>
      worker.evaluate(async (agentConfig) => {
        await chrome.storage.local.set({ agentConfig, turnLog: [] });
      }, config),
    openPage: async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },
    enableTabsAt: (url) =>
      worker.evaluate(async (at) => {
        const ids = (await chrome.tabs.query({ url: at })).flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
        await chrome.storage.session.set({ enabledTabs: ids });
      }, url),
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
    .addArguments('-headless')
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }));
  const driver = (await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    // opening a moz-extension:// tab needs the privileged (chrome) context
    .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access'))
    .build()) as firefox.Driver;
  await driver.installAddon(zip, true);
  console.log(`[e2e] add-on installed in Firefox from ${path.basename(zip)}`);

  // The extension's side: one of its pages, opened as a tab. Marionette will
  // not navigate to moz-extension:// itself, so the browser window opens it.
  await driver.get('about:blank');
  const pageTab = await driver.getWindowHandle();
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(
    `const w = Services.wm.getMostRecentWindow('navigator:browser');
     w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
    `moz-extension://${FIREFOX_UUID}/devtools-panel.html`,
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
    configure: (config) =>
      inExtension<void>('await browser.storage.local.set({ agentConfig: arg, turnLog: [] });', config),
    openPage: (url) => driver.get(url),
    enableTabsAt: (url) =>
      inExtension<void>(
        // tabs.query's url filter is a match pattern, and Firefox's carry no port.
        `const ids = (await browser.tabs.query({})).filter((t) => t.url === arg).map((t) => t.id);
         if (ids.length === 0) throw new Error('no tab at ' + arg);
         await browser.storage.session.set({ enabledTabs: ids });`,
        url,
      ),
    pageValue: (name) => driver.executeScript(`return window[arguments[0]];`, name),
    turnLog: () => inExtension<unknown[]>(`return (await browser.storage.local.get('turnLog')).turnLog ?? [];`),
    screenshot: async (file) => {
      await writeFile(file, Buffer.from(await driver.takeScreenshot(), 'base64'));
    },
    close: () => driver.quit(),
  };
}
