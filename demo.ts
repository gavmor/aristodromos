import { openai } from '@ai-sdk/openai';
import { createStore } from '@xstate/store';
import { generateText, tool } from 'ai';
import { effect, signal } from 'alien-signals';
import { applyPatch, Operation } from 'fast-json-patch';
import { create } from 'mutative';
import objectScan from 'object-scan';
import { Page } from 'playwright-core';
import { z } from 'zod';

// --- WXT Context & Lifecycle Emulation ---
interface WxtContext {
  setTimeout(cb: () => void, ms: number): number;
  onInvalidated(cb: () => void): void;
  isValidated: boolean;
}

class MockWxtContext implements WxtContext {
  private invalidationCallbacks: Array<() => void> = [];
  private activeTimeouts: Array<any> = [];
  public isValidated = true;

  public setTimeout(cb: () => void, ms: number): number {
    const id = setTimeout(() => {
      if (this.isValidated) cb();
    }, ms);
    this.activeTimeouts.push(id);
    return id as unknown as number;
  }

  public onInvalidated(cb: () => void): void {
    this.invalidationCallbacks.push(cb);
  }

  public invalidate() {
    console.log("\n[WXT Lifecycle] Triggering Context Invalidation (e.g., Tab Navigated, Tab Closed, or Extension Reloaded)...");
    this.isValidated = false;
    this.activeTimeouts.forEach(clearTimeout);
    this.invalidationCallbacks.forEach(cb => cb());
    this.invalidationCallbacks = [];
  }
}

// --- Chrome Extension API Mock for WXT v0.20+ (No Polyfills) ---
// Emulates the raw Chrome Message Passing where returning true synchronously keeps the channel alive.
const chromeMock = {
  runtime: {
    listeners: [] as Array<(message: any, sender: any, sendResponse: (response?: any) => void) => boolean | void>,

    sendMessage(message: any, responseCallback?: (response: any) => void) {
      console.log(`[Message Bus] 🌐 C2B Broadcast: ${message.type}`);

      // WXT uses native Structured Clone under the hood.
      // This preserves native JS types (Set, Map, Date, ArrayBuffer) across boundaries.
      const clonedMessage = structuredClone(message);

      let portKeptOpen = false;
      const sendResponse = (response: any) => {
        if (responseCallback) {
          responseCallback(structuredClone(response));
        }
      };

      this.listeners.forEach(listener => {
        const result = listener(clonedMessage, { tab: { id: 1 } }, sendResponse);
        if (result === true) {
          portKeptOpen = true;
        }
      });

      if (!portKeptOpen && responseCallback) {
        // Simulate the raw Chrome warning if listener terminates synchronously without returning true
        setTimeout(() => {
          // console.warn("Chrome Warning: The message port closed before a response was received.");
        }, 0);
      }
    },
    onMessage: {
      addListener(fn: any) { chromeMock.runtime.listeners.push(fn); }
    },
    lastError: null as any
  },
  tabs: {
    query(queryInfo: any, callback: Function) { callback([{ id: 1 }]); },
    sendMessage(tabId: number, message: any, responseCallback?: (response: any) => void) {
      console.log(`[Message Bus] 🎯 B2C Targeted to Tab ${tabId}: ${message.type}`);
      const clonedMessage = structuredClone(message);
      let portKeptOpen = false;
      const sendResponse = (response: any) => {
        if (responseCallback) {
          responseCallback(structuredClone(response));
        }
      };

      chromeMock.runtime.listeners.forEach(listener => {
        const result = listener(clonedMessage, { id: "background" }, sendResponse);
        if (result === true) {
          portKeptOpen = true;
        }
      });
    }
  }
};

// --- Type Definitions ---

interface PageState {
  newInformation: string[];
  affordances: Record<string, any>;
  metadataMap: Map<string, any>; // Native Map preserved via Structured Cloning
}

interface OperationSchema {
  allowedPaths: string[];
  allowedOperations: string[];
  description: string;
}

// --- 1. Content Script (Runs in isolated Tab) ---
class ContentScript {
  public axTreeState = signal<any>(null);
  private activeUIController: AbortController | null = null;
  private activeOTController: AbortController | null = null;

  constructor(ctx: WxtContext) {
    // ==========================================
    // HALF 1: THE EMITTER (Content -> Background)
    // ==========================================
    effect(() => {
      const axNode = this.axTreeState();
      if (!axNode) return;

      // Data-Driven Cancellation: Abort previous pending evaluations
      if (this.activeUIController) {
        console.log("[Content] Aborting old processing sequence due to fresh sensory mutation.");
        this.activeUIController.abort();
      }

      this.activeUIController = new AbortController();
      const signal = this.activeUIController.signal;

      const { scene, schema } = this.distillAXTreeToSchema(axNode);

      this.sendMessageWithAbort('SCENE_UPDATED', { scene, schema }, signal)
        .then((response: any) => {
          if (response?.status === 'success') {
            console.log('[Content] Background acknowledged new scene updates.');
          }
        })
        .catch((err: Error) => {
          if (err.name === 'AbortError') {
            console.log('[Content] Scene update messaging safely aborted.');
          }
        });
    });

    // ==========================================
    // HALF 2: THE PROCESSOR (Background -> Content)
    // ==========================================
    chromeMock.runtime.onMessage.addListener((message: any, sender: any, sendResponse: Function) => {
      if (message.direction === 'B2C' && message.type === 'EXECUTE_OT') {
        if (this.activeOTController) {
          console.warn('[Content] 🛑 Canceling active execution. New task arrived.');
          this.activeOTController.abort();
        }

        this.activeOTController = new AbortController();
        const otSignal = this.activeOTController.signal;

        this.applyOperationalTransformAsync(message.payload, otSignal)
          .then(() => sendResponse({ status: 'success' }))
          .catch((err: Error) => {
            if (err.name === 'AbortError') {
              sendResponse({ status: 'canceled' });
            } else {
              sendResponse({ status: 'error', error: err.message });
            }
          });

        // Standard raw API design pattern for WXT v0.20+
        // Synchronously returning true to tell WXT to keep the message port alive!
        return true;
      }
    });

    // ==========================================
    // DUAL-LAYER: Lifecycle-Driven Cancellation (WXT Context)
    // ==========================================
    ctx.onInvalidated(() => {
      console.log('[Content] 💀 WXT context invalidated. Killing all active controllers instantly.');
      if (this.activeUIController) this.activeUIController.abort();
      if (this.activeOTController) this.activeOTController.abort();
    });
  }

  /**
   * Abort-supported messaging wrapper
   */
  private sendMessageWithAbort(type: string, payload: any, abortSignal: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (abortSignal.aborted) return reject(new DOMException('Aborted', 'AbortError'));

      chromeMock.runtime.sendMessage(
        { direction: 'C2B', type, payload },
        (response) => {
          if (chromeMock.runtime.lastError) return reject(chromeMock.runtime.lastError);
          resolve(response);
        }
      );

      abortSignal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  }

  /**
   * Integrates Playwright's native Accessibility Tree extraction
   */
  public async fetchRealSceneContext(page: Page) {
    console.log("\n[Content] Capturing native Accessibility Tree via Playwright...");
    const axNode = await page.accessibility.snapshot();
    this.axTreeState(axNode);
  }

  /**
   * Transforms raw AXNode using object-scan and preserves native structural data
   */
  public distillAXTreeToSchema(axNode: any) {
    const interactablePathArrays = axNode ? objectScan(['**[*]'], {
      filterFn: ({ value }) => value && typeof value === 'object' && ['button', 'textbox'].includes(value.role),
      rtn: 'path'
    })(axNode) : [];

    const dynamicPaths = interactablePathArrays.map((p: string[]) => {
      const basePointer = '/' + p.join('/');
      const role = p.reduce((obj: any, key: string) => obj[key], axNode)?.role;
      return basePointer + (role === 'button' ? '/clicked' : '/value');
    });

    // Utilizing Structured Clone feature to transport native Map metadata across the channel
    const metadataMap = new Map<string, any>();
    metadataMap.set("scanTimestamp", new Date());
    metadataMap.set("interactiveNodeCount", dynamicPaths.length);

    return {
      state: {
        newInformation: [`Extracted live scene from Playwright AXTree`],
        affordances: axNode ? axNode.children : {},
        metadataMap: metadataMap
      } as PageState,
      schema: {
        allowedPaths: dynamicPaths.length > 0 ? dynamicPaths : ["/form/submit/clicked"],
        allowedOperations: ["replace"],
        description: "Apply 'replace' operations to interact with affordances."
      } as OperationSchema
    };
  }

  /**
   * Applies standard JSON Patch mutations cancelably
   */
  public async applyOperationalTransformAsync(otPayload: Operation[], abortSignal: AbortSignal) {
    console.log(`\n[Content] Starting cancelable OT application (${otPayload.length} operations)...`);

    for (const patch of otPayload) {
      if (abortSignal.aborted) throw new DOMException('OT application canceled', 'AbortError');

      // Staggered execution simulation
      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(resolve, 800);
        abortSignal.addEventListener('abort', () => {
          clearTimeout(timeoutId);
          reject(new DOMException('OT application canceled', 'AbortError'));
        });
      });

      console.log(` -> [DOM Execution] Applying patch: ${patch.op} at ${patch.path}`);
      const nextState = create(this.axTreeState(), (draft) => {
        applyPatch(draft, [patch]);
      });
      this.axTreeState(nextState);
    }
  }
}


// --- 2. Background Script (Runs in global Service Worker) ---

const generateActionSchema = (allowedPaths: string[]) => z.object({
  intent: z.string().describe("Plain text reasoning for the framework logger"),
  op: z.literal("replace"),
  path: z.string().refine(val => allowedPaths.includes(val), { message: "Invalid DOM path hallucination" }),
  value: z.any()
});

const agentStore = createStore({
  context: { status: 'idle' },
  on: {
    START_RUMINATING: (ctx) => ({ ...ctx, status: 'ruminating' }),
    SCENE_READY: (ctx) => ({ ...ctx, status: 'acting' }),
    TASK_COMPLETE: (ctx) => ({ ...ctx, status: 'terminated' })
  }
});

class BackgroundScript {
  public memories = signal<string[]>([]);
  public lifecycleStatus = signal<string>('idle');

  private activeAIController: AbortController | null = null;
  private operationQueue: Operation[] = [];

  constructor() {
    agentStore.subscribe((state) => {
      this.lifecycleStatus(state.context.status);
    });

    // ==========================================
    // PROCESSOR BLOCK (Content -> Background)
    // ==========================================
    chromeMock.runtime.onMessage.addListener((message: any, sender: any, sendResponse: Function) => {
      if (message.direction === 'C2B' && message.type === 'SCENE_UPDATED') {

        if (this.activeAIController) {
          console.warn('[Background] 🛑 Scene changed mid-thought! Canceling active AI loop.');
          this.activeAIController.abort();
        }

        const { scene, schema } = message.payload;

        // Demo structured clone support: accessing native Map transported safely across background bridge
        const metadata: Map<string, any> = scene.metadataMap;
        console.log(`[Background] Received telemetry metadata - Interactive elements count: ${metadata.get("interactiveNodeCount")}`);

        if (scene.affordances && scene.affordances["btn-a3f1"]?.clicked === true) {
          console.log("\n[Background] Task success verified from new scene. Transitioning to Terminated.");
          agentStore.send({ type: 'TASK_COMPLETE' });
          sendResponse({ status: 'success' });
          return false;
        }

        agentStore.send({ type: 'SCENE_READY' });
        this.activeAIController = new AbortController();

        this.executeAgentFrameworkSim(schema, this.activeAIController.signal)
          .then(() => sendResponse({ status: 'success' }))
          .catch((err: Error) => {
            if (err.name === 'AbortError') sendResponse({ status: 'canceled' });
          });

        // Keep channel alive for async reply
        return true;
      }
    });
  }

  public ruminate() {
    agentStore.send({ type: 'START_RUMINATING' });
    console.log("\n[Lifecycle: Ruminating] Extracting facts in isolation...");
    this.memories(["Rule: Fill password first", "Fact: Admin handle is 'admin_master'"]);
  }

  // ==========================================
  // EMITTER BLOCK (Background -> Content)
  // ==========================================
  public queueActionAndFlushToTab(action: Operation) {
    console.log(`[Background] Queued strictly validated action: ${action.op} on ${action.path}`);
    this.operationQueue.push(action);

    const otPayload = [...this.operationQueue];
    this.operationQueue = [];

    chromeMock.tabs.query({ active: true, currentWindow: true }, (tabs: any) => {
      if (tabs.length > 0) {
        console.log(`[Background] Emitting OT payload to Tab ${tabs[0].id}`);
        chromeMock.tabs.sendMessage(
          tabs[0].id,
          { direction: 'B2C', type: 'EXECUTE_OT', payload: otPayload },
          (response: any) => {
            if (chromeMock.runtime.lastError) console.warn('[Background] Could not reach content script.');
          }
        );
      }
    });
  }

  private async executeAgentFrameworkSim(schema: OperationSchema, abortSignal: AbortSignal) {
    console.log("\n[Lifecycle: Acting] Delegating to Vercel AI SDK...");

    try {
      const result = await generateText({
        model: openai('gpt-4o'),
        system: "You are an autonomous web agent. Ruminate, then use the interact tool.",
        prompt: "Log in to the portal.",
        abortSignal: abortSignal,
        tools: {
          interact: tool({
            description: schema.description,
            parameters: generateActionSchema(schema.allowedPaths),
            execute: async (patch) => {
              this.queueActionAndFlushToTab(patch);
              return `Successfully dispatched ${patch.op} at ${patch.path}.`;
            }
          })
        },
        maxSteps: 10
      });

      console.log("[Agent Framework] Vercel SDK Loop Complete.");
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error("[Agent Framework] Execution Error:", error);
      }
    }
  }
}


// --- Execution Orchestration ---
console.log("==================================================");
console.log("INITIALIZING EXTENSION-NATIVE BIPARTITE ARCHITECTURE");
console.log("==================================================");

(async () => {
  // 1. Initialize WXT Context & Scripts
  const wxtContext = new MockWxtContext();
  const backgroundScript = new BackgroundScript();
  const contentScript = new ContentScript(wxtContext);

  // 2. Start Rumination
  backgroundScript.ruminate();

  console.log("\n[Orchestrator] Simulating Playwright Headless Browser Connection...");

  // Mocking the Playwright Page API for this simulation
  const mockPage = {
    accessibility: {
      snapshot: async () => ({
        role: 'WebArea',
        name: 'User Login Portal',
        children: {
          "inp-user": { role: 'textbox', value: '' },
          "inp-pass": { role: 'textbox', value: '' },
          "btn-a3f1": { role: 'button', clicked: false }
        }
      })
    }
  } as unknown as Page;

  // 3. Trigger initial sensory pull to run the complete reactive pipeline
  await contentScript.fetchRealSceneContext(mockPage);

  // 4. Simulate a sudden Tab Context Navigation (Trigger WXT lifecycle destruction mid-flight)
  wxtContext.setTimeout(() => {
    wxtContext.invalidate();
  }, 1200);

})();
