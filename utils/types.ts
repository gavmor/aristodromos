import { Operation } from 'fast-json-patch';

// ---------------------------------------------------------------------------
// Types matching demo.ts PageState, OperationSchema, Operation
// ---------------------------------------------------------------------------

/** Accessibility tree node (mirrors Playwright AXNode shape) */
export interface AXNode {
  role: string;
  name?: string;
  value?: string | boolean;
  /** How the user can interact with this element, derived from the actual DOM element type */
  affordance?: 'click' | 'input';
  children?: Record<string, AXNode>;
}

/** Page state sent C2B — matches demo.ts PageState */
export interface PageState {
  newInformation: string[];
  affordances: Record<string, AXNode>;
  metadataMap: Map<string, unknown>;
}

/** Allowed operation schema — matches demo.ts OperationSchema */
export interface OperationSchema {
  allowedPaths: string[];
  allowedOperations: string[];
  description: string;
}

/** Scene payload sent C2B */
export interface ScenePayload {
  scene: PageState;
  schema: OperationSchema;
}

/** Re-export Operation from fast-json-patch for external use */
export type { Operation };

// ---------------------------------------------------------------------------
// Message protocol
// ---------------------------------------------------------------------------

/** C2B: content → background */
export interface SceneUpdatedMessage {
  direction: 'C2B';
  type: 'SCENE_UPDATED';
  payload: ScenePayload;
}

/** B2C: background → content */
export interface ExecuteOTMessage {
  direction: 'B2C';
  type: 'EXECUTE_OT';
  payload: Operation[];
}
