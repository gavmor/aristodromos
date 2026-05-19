import { RandomClickStrategy } from '../utils/random-click-strategy';
import type { AgentStrategy } from '../utils/strategy';
import { decideSceneTransition, recordMemory, type LifecycleStatus } from '../utils/bg-handler';
import type { OperationSchema } from '../utils/types';

// Swap strategy implementations as needed:
//   new LLMStrategy()     — uses ollama for LLM-driven decisions
//   new RandomClickStrategy() — picks random clickable elements for testing
const strategy: AgentStrategy = new RandomClickStrategy();

let lifecycleStatus: LifecycleStatus = 'idle';
let memories: string[] = [];
let activeAIController: AbortController | null = null;
let paused = false;

function logStatus(s: LifecycleStatus) {
  lifecycleStatus = s;
  console.log(`[Lifecycle] Status → ${s}`);
}

export default defineBackground(() => {
  logStatus('ruminating');
  console.log(`[Agent] Using strategy: ${strategy.name}`);
  memories = ['Browser automation agent initialized', 'Goal: Explore page and interact with elements'];

  // Show running badge on startup
  browser.action.setBadgeText({ text: '▶' });
  browser.action.setBadgeBackgroundColor({ color: '#2e7d32' });

  // ACTION: click extension icon to pause/resume the agent
  browser.action.onClicked.addListener(async () => {
    paused = !paused;
    await browser.action.setBadgeText({ text: paused ? '⏸' : '▶' });
    await browser.action.setBadgeBackgroundColor({ color: paused ? '#666' : '#2e7d32' });
    console.log(`[Action] Agent ${paused ? 'paused' : 'resumed'}`);
  });

  // PROCESSOR: handle SCENE_UPDATED from content
  browser.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    if (message.direction !== 'C2B' || message.type !== 'SCENE_UPDATED') return;

    // When paused, ignore scene updates silently
    if (paused) {
      sendResponse({ status: 'paused' });
      return false;
    }

    const { scene, schema } = message.payload as {
      scene: { newInformation: string[]; affordances: Record<string, any> };
      schema: OperationSchema;
    };

    // Pure decision: is the task complete? should we abort previous loop?
    const decision = decideSceneTransition(scene, lifecycleStatus, activeAIController != null);

    if (decision.transition === 'complete') {
      logStatus('terminated');
      sendResponse({ status: 'success' });
      return false;
    }

    if (decision.transition === 'abort') {
      activeAIController!.abort();
    }

    logStatus('acting');
    activeAIController = new AbortController();

    strategy.decide(schema, scene.newInformation, activeAIController.signal)
      .then((agentDecision) => {
        const ops = agentDecision.operations;
        console.log(`[Agent] ${strategy.name} reasoning:`, agentDecision.reasoning);

        // Check for LLM-signaled completion (/complete path)
        const hasComplete = ops.some((op) => op.path === '/complete');
        if (hasComplete) {
          logStatus('terminated');
          sendResponse({ status: 'success' });
          return;
        }

        const actionable = ops.filter((op) => op.path !== '/complete');
        if (actionable.length > 0) {
          const tabId = sender.tab?.id;
          if (tabId != null) {
            browser.tabs.sendMessage(tabId, {
              direction: 'B2C', type: 'EXECUTE_OT', payload: actionable,
            }).catch(() => {});
          }
        }

        memories = recordMemory(memories, `Step: ${agentDecision.reasoning}`);
        sendResponse({ status: 'success' });
      })
      .catch((err: Error) => {
        console.error(`[Agent] ${strategy.name} error:`, err.message);
        sendResponse({ status: err.name === 'AbortError' ? 'canceled' : 'error', error: err.message });
      });

    return true; // keep channel open
  });
});
