import { callOllama, buildSystemPrompt, buildObservationPrompt, OLLAMA_MODEL } from '../utils/agent';
import { decideSceneTransition, recordMemory, type LifecycleStatus } from '../utils/bg-handler';
import type { OperationSchema } from '../utils/types';

let lifecycleStatus: LifecycleStatus = 'idle';
let memories: string[] = [];
let activeAIController: AbortController | null = null;
let operationQueue: import('fast-json-patch').Operation[] = [];

function logStatus(s: LifecycleStatus) {
  lifecycleStatus = s;
  console.log(`[Lifecycle] Status → ${s}`);
}

export default defineBackground(() => {
  logStatus('ruminating');
  memories = ['Browser automation agent initialized', 'Goal: Explore page and interact with elements'];

  // PROCESSOR: handle SCENE_UPDATED from content
  browser.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    if (message.direction !== 'C2B' || message.type !== 'SCENE_UPDATED') return;

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

    executeAgentLoop(schema, scene.newInformation, activeAIController.signal)
      .then((ops) => {
        if (ops.length > 0) {
          const tabId = sender.tab?.id;
          if (tabId != null) {
            browser.tabs.sendMessage(tabId, {
              direction: 'B2C', type: 'EXECUTE_OT', payload: ops,
            }).catch(() => {});
          }
        }
        sendResponse({ status: 'success' });
      })
      .catch((err: Error) => {
        sendResponse({ status: err.name === 'AbortError' ? 'canceled' : 'error', error: err.message });
      });

    return true; // keep channel open
  });
});

async function executeAgentLoop(
  schema: OperationSchema,
  newInformation: string[],
  abortSignal: AbortSignal,
) {
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildObservationPrompt(schema, newInformation) },
  ];

  if (memories.length > 0) {
    messages.push({
      role: 'assistant',
      content: JSON.stringify({ reasoning: 'I recall previous context.', memories }),
    });
  }

  const raw = await callOllama(OLLAMA_MODEL, messages, abortSignal);
  const parsed = JSON.parse(raw);

  console.log('[Agent] Reasoning:', parsed.reasoning);
  const ops: import('fast-json-patch').Operation[] = [];

  if (Array.isArray(parsed.operations)) {
    for (const op of parsed.operations) {
      if (op.path === '/complete') {
        logStatus('terminated');
        continue;
      }
      ops.push(op);
    }
  }

  memories = recordMemory(memories, `Step: ${parsed.reasoning}`);
  return ops;
}
