import type { Operation } from 'fast-json-patch';
import type { OperationSchema } from './types';

// ---------------------------------------------------------------------------
// Lifecycle state
// ---------------------------------------------------------------------------

export type LifecycleStatus = 'idle' | 'ruminating' | 'acting' | 'terminated';

// ---------------------------------------------------------------------------
// Pure decision logic for the SCENE_UPDATED handler
// Testable without WXT or browser APIs.
// ---------------------------------------------------------------------------

export interface SceneContext {
  newInformation: string[];
  affordances: Record<string, { role?: string; value?: string | boolean }>;
}

export interface SceneDecision {
  /** True if the task is complete and no further processing is needed */
  isComplete: boolean;
  /** Updated status */
  status: LifecycleStatus;
  /** The type of scene transition */
  transition: 'noop' | 'complete' | 'abort' | 'act';
}

/**
 * Pure function: given the current scene context and lifecycle status,
 * decide what transition to take. No side effects, no API calls.
 */
export function decideSceneTransition(
  scene: SceneContext,
  currentStatus: LifecycleStatus,
  hasPreviousAILoop: boolean,
): SceneDecision {
  // Check for task completion — a button with value=true signals affirmative click
  const anyClicked = Object.values(scene.affordances).some(
    (n) => n.role === 'button' && n.value === true,
  );

  if (anyClicked) {
    return {
      isComplete: true,
      status: 'terminated',
      transition: 'complete',
    };
  }

  if (currentStatus === 'terminated') {
    return {
      isComplete: true,
      status: 'terminated',
      transition: 'noop',
    };
  }

  return {
    isComplete: false,
    status: 'acting',
    transition: hasPreviousAILoop ? 'abort' : 'act',
  };
}

// ---------------------------------------------------------------------------
// Memory management — pure
// ---------------------------------------------------------------------------

export function recordMemory(memories: string[], entry: string, max = 20): string[] {
  return [...memories, entry].slice(-max);
}
