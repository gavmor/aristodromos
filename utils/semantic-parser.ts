import { computeAccessibleName, getRole } from 'dom-accessibility-api';
import { roles as ariaRoles } from 'aria-query';
import {
  ActionNode,
  ContentNode,
  NodeCategory,
  NodeId,
  Perception,
  Relations,
  SceneNode,
  StateNode,
  StructureNode,
} from './scene';
import {
  NodeIdMirror,
  semanticSignature,
  structuralPath,
} from './node-identity';
import { deriveActuation } from './actuation';

export interface ParseContext {
  mirror: NodeIdMirror;
}

interface NodeBase {
  id: NodeId;
  role: string;
  name?: string;
  relations: Relations;
  perception: Perception;
}

const STATE_ROLES = new Set([
  'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton',
  'checkbox', 'radio', 'switch', 'scrollbar',
]);
const ACTION_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem', 'option',
]);
const STRUCTURE_ROLES = new Set([
  'form', 'search', 'dialog', 'alertdialog', 'navigation', 'main', 'region',
  'complementary', 'banner', 'contentinfo', 'list', 'group', 'tablist',
  'table', 'grid', 'menu', 'menubar', 'tree', 'toolbar', 'radiogroup',
]);
const CONTENT_ROLES = new Set([
  'heading', 'img', 'status', 'alert', 'log', 'note', 'paragraph',
  'definition', 'term', 'figure',
]);
const NON_SALIENT_ROLES = new Set(['generic', 'presentation', 'none']);
const SCOPING_ROLES = new Set([
  'form', 'dialog', 'alertdialog', 'list', 'group', 'navigation', 'main',
  'region', 'tablist', 'table', 'grid', 'menu', 'tree', 'toolbar', 'radiogroup',
]);

function roleSupers(role: string): string[] {
  const map = ariaRoles as unknown as Map<string, { superClass: string[][] }>;
  const def = map.get(role);
  return def ? def.superClass.flat() : [];
}

function isValueBearing(el: Element): boolean {
  return 'value' in el || el.hasAttribute('aria-valuenow') || el.hasAttribute('aria-checked');
}

export function classifyCategory(role: string, el: Element): NodeCategory {
  if (STATE_ROLES.has(role)) return 'state';
  if (ACTION_ROLES.has(role)) return 'action';
  if (STRUCTURE_ROLES.has(role)) return 'structure';
  if (CONTENT_ROLES.has(role)) return 'content';
  const supers = roleSupers(role);
  if (supers.includes('landmark') || supers.includes('structure')) return 'structure';
  if (supers.includes('widget')) return isValueBearing(el) ? 'state' : 'action';
  return 'content';
}

export function isVisible(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if ((el as HTMLElement).hidden) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (style.opacity === '0') return false;
  return true;
}

export function isDisabled(el: Element): boolean {
  if ((el as HTMLInputElement).disabled === true) return true;
  return el.getAttribute('aria-disabled') === 'true';
}

/** Local perception only. inViewport/occluded/inertByModal are overlaid by the
 *  projector from global-event sources; focused is local (activeElement). */
export function parseLocalPerception(el: Element): Perception {
  return {
    visible: isVisible(el),
    disabled: isDisabled(el),
    focused: el.ownerDocument.activeElement === el,
    inViewport: false,
    occluded: false,
    inertByModal: false,
  };
}

function prune<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function boolAttr(el: Element, prop: string, aria: string): true | undefined {
  if ((el as unknown as Record<string, unknown>)[prop] === true) return true;
  if (el.getAttribute(aria) === 'true') return true;
  return undefined;
}

function refs(el: Element, attr: string, ctx: ParseContext): NodeId[] | undefined {
  const raw = el.getAttribute(attr);
  if (!raw) return undefined;
  const ids = raw
    .split(/\s+/)
    .map((domId) => el.ownerDocument.getElementById(domId))
    .filter((n): n is HTMLElement => n !== null)
    .map((n) => ctx.mirror.idFor(n));
  return ids.length ? ids : undefined;
}

function containerOf(el: Element, ctx: ParseContext): NodeId | undefined {
  let cur = el.parentElement;
  while (cur) {
    const r = getRole(cur);
    if (r && SCOPING_ROLES.has(r)) return ctx.mirror.idFor(cur);
    cur = cur.parentElement;
  }
  return undefined;
}

export function parseRelations(el: Element, ctx: ParseContext): Relations {
  return prune({
    container: containerOf(el, ctx),
    labelledBy: refs(el, 'aria-labelledby', ctx),
    describedBy: refs(el, 'aria-describedby', ctx),
    controls: refs(el, 'aria-controls', ctx),
    owns: refs(el, 'aria-owns', ctx),
  });
}

function stateControl(el: Element, role: string): StateNode['control'] {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'select' || role === 'listbox' || role === 'combobox') return 'option';
  if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch') {
    return 'boolean';
  }
  if (type === 'range' || role === 'slider' || role === 'spinbutton') return 'range';
  if (role === 'scrollbar') return 'scroll';
  if (tag === 'input' || tag === 'textarea' || role === 'textbox' || role === 'searchbox') return 'text';
  return 'aria';
}

function readValue(el: Element, control: StateNode['control']): string | boolean | number | null {
  if (control === 'boolean') {
    if ('checked' in el) return (el as HTMLInputElement).checked;
    return el.getAttribute('aria-checked') === 'true';
  }
  if (control === 'range') {
    const raw = 'value' in el ? (el as HTMLInputElement).value : el.getAttribute('aria-valuenow');
    return raw != null && raw !== '' ? Number(raw) : null;
  }
  if (control === 'option' && 'value' in el) return (el as HTMLSelectElement).value;
  if ('value' in el) return (el as HTMLInputElement).value;
  return el.textContent?.trim() ?? null;
}

function readOptions(el: Element): { value: string; label: string }[] | undefined {
  if (el.tagName.toLowerCase() === 'select') {
    return Array.from((el as HTMLSelectElement).options).map((o) => ({
      value: o.value,
      label: o.label || o.text,
    }));
  }
  const opts = Array.from(el.querySelectorAll('[role="option"]'));
  if (!opts.length) return undefined;
  return opts.map((o) => ({
    value: o.getAttribute('value') ?? computeAccessibleName(o),
    label: computeAccessibleName(o),
  }));
}

function buildStateNode(el: Element, base: NodeBase, role: string): StateNode {
  const control = stateControl(el, role);
  const node: StateNode = {
    ...base,
    category: 'state',
    control,
    value: readValue(el, control),
    actuation: deriveActuation(el),
  };
  if (control === 'option') node.options = readOptions(el);
  node.required = boolAttr(el, 'required', 'aria-required');
  node.readOnly = boolAttr(el, 'readOnly', 'aria-readonly');
  if (el.getAttribute('aria-invalid') === 'true') node.invalid = true;
  const placeholder = el.getAttribute('placeholder');
  if (placeholder !== null) node.placeholder = placeholder;
  return prune(node);
}

function actionKind(el: Element, role: string): ActionNode['action'] {
  if (el.tagName.toLowerCase() === 'a' && el.hasAttribute('href')) return 'navigate';
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'submit' || role === 'form') return 'submit';
  return 'click';
}

function submitTarget(el: Element, ctx: ParseContext): ActionNode['submits'] | undefined {
  const form = (el as HTMLInputElement).form ?? el.closest('form');
  if (!form) return undefined;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type !== 'submit' && el.tagName.toLowerCase() !== 'button') return undefined;
  const method = (form as HTMLFormElement).method?.toLowerCase() === 'post' ? 'post' : 'get';
  const submits: NonNullable<ActionNode['submits']> = { formId: ctx.mirror.idFor(form), method };
  const action = form.getAttribute('action');
  if (action !== null) submits.actionUrl = action;
  return submits;
}

function tristate(el: Element, attr: string): boolean | undefined {
  const v = el.getAttribute(attr);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function buildActionNode(el: Element, base: NodeBase, role: string, ctx: ParseContext): ActionNode {
  const node: ActionNode = {
    ...base,
    category: 'action',
    action: actionKind(el, role),
    actuation: deriveActuation(el),
  };
  const href = el.getAttribute('href');
  if (href !== null) node.href = href;
  const submits = submitTarget(el, ctx);
  if (submits) node.submits = submits;
  node.expanded = tristate(el, 'aria-expanded');
  node.pressed = tristate(el, 'aria-pressed');
  return prune(node);
}

function headingLevel(el: Element): number | undefined {
  const m = /^h([1-6])$/.exec(el.tagName.toLowerCase());
  if (m) return Number(m[1]);
  const aria = el.getAttribute('aria-level');
  return aria ? Number(aria) : undefined;
}

function liveness(el: Element, role: string): 'polite' | 'assertive' | undefined {
  const live = el.getAttribute('aria-live');
  if (live === 'polite' || live === 'assertive') return live;
  if (role === 'alert') return 'assertive';
  if (role === 'status' || role === 'log') return 'polite';
  return undefined;
}

function buildContentNode(el: Element, base: NodeBase, role: string): ContentNode {
  const node: ContentNode = {
    ...base,
    category: 'content',
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  };
  if (role === 'heading') node.level = headingLevel(el);
  node.live = liveness(el, role);
  return prune(node);
}

const LANDMARKS: Record<string, StructureNode['landmark']> = {
  form: 'form', dialog: 'dialog', alertdialog: 'dialog', navigation: 'navigation',
  main: 'main', region: 'region', list: 'list', group: 'group', tablist: 'tablist',
  banner: 'banner', contentinfo: 'contentinfo',
};

function isModal(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'dialog' && (el as HTMLDialogElement).open) return true;
  const role = el.getAttribute('role');
  return (role === 'dialog' || role === 'alertdialog') && el.getAttribute('aria-modal') === 'true';
}

function buildStructureNode(el: Element, base: NodeBase, role: string): StructureNode {
  const node: StructureNode = { ...base, category: 'structure' };
  if (LANDMARKS[role]) node.landmark = LANDMARKS[role];
  if (isModal(el)) node.modal = true;
  if (el.tagName.toLowerCase() === 'form') {
    node.method = (el as HTMLFormElement).method?.toLowerCase() === 'post' ? 'post' : 'get';
    const action = el.getAttribute('action');
    if (action !== null) node.actionUrl = action;
  }
  return prune(node);
}

/**
 * Inputs the HTML-AAM gives "no corresponding role", which `getRole` honestly
 * reports as null — and which `parseNode` would then drop entirely. A password
 * field vanishing from a model whose entire claim is fidelity is not an
 * acceptable omission, and browsers do expose these in the AX tree. So the
 * exception is named here rather than left as a silent blind spot. All of them
 * are text-shaped state: a settable string value.
 */
const ROLELESS_TEXT_INPUTS = new Set([
  'password', 'date', 'datetime-local', 'month', 'week', 'time', 'color',
]);

/**
 * Implicit roles the HTML-AAM assigns that `dom-accessibility-api`'s tag table
 * lacks. Without `p`, every paragraph of prose on a page was dropped, so the
 * brain saw a story's choices but never the story.
 */
const MISSING_IMPLICIT_ROLES: Record<string, string> = { p: 'paragraph' };

export function resolveRole(el: Element): string | null {
  const role = getRole(el);
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  const implicit = MISSING_IMPLICIT_ROLES[tag];
  if (implicit) return implicit;
  if (tag !== 'input') return null;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  return ROLELESS_TEXT_INPUTS.has(type) ? 'textbox' : null;
}

/** Project a single DOM element into its SceneNode, or null if not salient. */
export function parseNode(el: Element, ctx: ParseContext): SceneNode | null {
  const role = resolveRole(el);
  if (!role || NON_SALIENT_ROLES.has(role)) return null;
  const name = computeAccessibleName(el) || undefined;
  const id = ctx.mirror.idFor(el, semanticSignature(role, name, structuralPath(el)));
  const base: NodeBase = prune({
    id,
    role,
    name,
    relations: parseRelations(el, ctx),
    perception: parseLocalPerception(el),
  });
  switch (classifyCategory(role, el)) {
    case 'state': return buildStateNode(el, base, role);
    case 'action': return buildActionNode(el, base, role, ctx);
    case 'content': return buildContentNode(el, base, role);
    case 'structure': return buildStructureNode(el, base, role);
  }
}
