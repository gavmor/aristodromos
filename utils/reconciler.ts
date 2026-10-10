// The down-edge: turn an emitted Plan back into page effects.
//
// Every node carries its own `Actuation` recipe (derived at parse time), so this
// module is a dispatcher, not a heuristics pile. That matters because a bare
// `.click()` or `.value =` silently no-ops on framework-controlled widgets, and
// under at-least-once delivery a silent no-op degenerates into an infinite
// retry: the plan is re-emitted forever because the world never changes.
//
// Two rules keep the loop honest:
//   - A setState whose target already holds the value is reported `noop`, not
//     re-applied. Convergence is observed, not assumed.
//   - A node id that no longer resolves is reported `stale`, not silently
//     dropped. The next observation will carry the replacement.
import { dispatchSequence, POINTER_SEQUENCE, setNativeValue } from './actuation';
import type { PlanAction } from './action-schema';
import type { SceneNode, StateNode } from './scene';

export type ApplyStatus = 'applied' | 'noop' | 'stale' | 'rejected';

export interface ApplyResult {
  nodeId: string;
  kind: PlanAction['kind'];
  status: ApplyStatus;
  detail?: string;
}

export interface ReconcilerDeps {
  /** live element for a NodeId, or undefined once the page has replaced it */
  resolve: (nodeId: string) => Element | undefined;
  /** the node as last projected, for its actuation recipe and current value */
  nodeOf: (nodeId: string) => SceneNode | undefined;
}

/** Current on-page value, read the same way the parser read it. */
function readLive(el: Element, node: StateNode): string | boolean | number | null {
  if (node.control === 'boolean') return (el as HTMLInputElement).checked;
  if ('value' in el) {
    const raw = (el as HTMLInputElement).value;
    return node.control === 'range' || node.control === 'scroll' ? Number(raw) : raw;
  }
  return el.textContent;
}

/**
 * Write the value, and report whether doing so already produced the node's
 * events. A checkbox is the awkward case: `.click()` is the only write that
 * frameworks reliably observe, and it fires click/input/change itself — setting
 * `.checked` and THEN dispatching a click would toggle it straight back.
 */
function writeValue(el: Element, node: StateNode, value: string | number | boolean): boolean {
  const strategy = node.actuation.setStrategy;
  if (strategy === 'toggle-checked') {
    (el as HTMLElement).click();
    return true;
  }
  if (strategy === 'select-option') {
    (el as HTMLSelectElement).value = String(value);
    return false;
  }
  if (strategy === 'scroll') {
    (el as HTMLElement).scrollTop = Number(value);
    return false;
  }
  if (strategy === 'native-value') {
    el.textContent = String(value);
    return false;
  }
  setNativeValue(el as HTMLInputElement, String(value));
  return false;
}

function fire(el: Element, node: SceneNode): void {
  const actuation = 'actuation' in node ? node.actuation : undefined;
  const strategy = actuation?.fireStrategy;
  if (strategy === 'native-click') {
    (el as HTMLElement).click();
    return;
  }
  if (strategy === 'submit-event') {
    (el as HTMLInputElement).form?.requestSubmit();
    return;
  }
  if (strategy === 'enter-key') {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return;
  }
  dispatchSequence(el, actuation?.events ?? POINTER_SEQUENCE);
}

function applySetState(action: PlanAction & { kind: 'setState' }, deps: ReconcilerDeps): ApplyResult {
  const node = deps.nodeOf(action.nodeId);
  const el = deps.resolve(action.nodeId);
  if (!node || !el) return { nodeId: action.nodeId, kind: 'setState', status: 'stale' };
  if (node.category !== 'state') {
    return { nodeId: action.nodeId, kind: 'setState', status: 'rejected', detail: `not a state node (${node.category})` };
  }
  if (readLive(el, node) === action.value) {
    return { nodeId: action.nodeId, kind: 'setState', status: 'noop', detail: 'already converged' };
  }
  const dispatched = writeValue(el, node, action.value);
  if (!dispatched) dispatchSequence(el, node.actuation.events ?? ['input', 'change']);
  return { nodeId: action.nodeId, kind: 'setState', status: 'applied', detail: String(action.value) };
}

function applyClick(action: PlanAction & { kind: 'clickTrigger' }, deps: ReconcilerDeps): ApplyResult {
  const node = deps.nodeOf(action.nodeId);
  const el = deps.resolve(action.nodeId);
  if (!node || !el) return { nodeId: action.nodeId, kind: 'clickTrigger', status: 'stale' };
  if (node.category !== 'action') {
    return { nodeId: action.nodeId, kind: 'clickTrigger', status: 'rejected', detail: `not an action node (${node.category})` };
  }
  if (node.perception.disabled) {
    return { nodeId: action.nodeId, kind: 'clickTrigger', status: 'rejected', detail: 'disabled' };
  }
  fire(el, node);
  return { nodeId: action.nodeId, kind: 'clickTrigger', status: 'applied' };
}

/** Apply one emitted action. Pure dispatch over the node's own recipe. */
export function applyAction(action: PlanAction, deps: ReconcilerDeps): ApplyResult {
  return action.kind === 'setState' ? applySetState(action, deps) : applyClick(action, deps);
}

/**
 * Apply a whole plan in order. Sequencing matters: the plan's own ordering is
 * what makes "fill the field, THEN submit" work within a single turn.
 */
export function applyPlan(actions: PlanAction[], deps: ReconcilerDeps): ApplyResult[] {
  return actions.map((action) => applyAction(action, deps));
}

export function summarize(results: ApplyResult[]): string {
  if (results.length === 0) return 'no actions';
  return results.map((r) => `${r.kind}(${r.nodeId})=${r.status}`).join(' ');
}
