import type { AXNode, PageState, OperationSchema } from './types';

// ---------------------------------------------------------------------------
// Build AX tree from live DOM — mirrors demo.ts ContentScript.fetchRealSceneContext
// ---------------------------------------------------------------------------

/** ARIA roles that make an element interactive / clickable */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem',
  'option', 'switch', 'slider', 'combobox', 'searchbox',
]);

/** Native interactive HTML tag names */
const INTERACTIVE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'details', 'summary',
]);

const TEXT_INPUT_TYPES = new Set([
  'text', 'email', 'password', 'search', 'tel', 'url', 'number',
  'date', 'time', 'datetime-local', 'month', 'week', 'color',
]);

const CLICK_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'submit', 'reset', 'button', 'image', 'file',
]);

/** Check whether an element should be considered interactive */
function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();

  // Native interactive tags
  if (INTERACTIVE_TAGS.has(tag)) return true;

  // ARIA role implies interactivity
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;

  // tabindex (not -1) means focusable → interactive
  const ti = el.getAttribute('tabindex');
  if (ti !== null && ti !== '-1') return true;

  // contenteditable makes an element editable → interactive
  const ce = el.getAttribute('contenteditable');
  if (ce === 'true' || ce === '') return true;

  // Inline event handlers imply interactivity
  if (el.hasAttribute('onclick') ||
      el.hasAttribute('onmousedown') ||
      el.hasAttribute('onkeydown')) return true;

  return false;
}

/** Compute the ARIA role for an interactive element */
function computeRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();

  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'details') return 'group';
  if (tag === 'summary') return 'button';

  if (tag === 'input') {
    const input = el as HTMLInputElement;
    if (input.type === 'checkbox') return 'checkbox';
    if (input.type === 'radio') return 'radio';
    if (input.type === 'submit' || input.type === 'reset' || input.type === 'button' || input.type === 'image') {
      return 'button';
    }
    if (TEXT_INPUT_TYPES.has(input.type)) return 'textbox';
    return 'textbox';
  }

  if (tag === 'textarea') return 'textbox';

  return tag;
}

/** Index counter per tag for generating unique keys */
function keyIndex(el: Element, counts: Map<string, number>): string {
  const tag = el.tagName.toLowerCase();
  const i = counts.get(tag) ?? 0;
  counts.set(tag, i + 1);
  return `el-${tag}-${i}`;
}

export function buildAXTree(): { axNode: AXNode; elementMap: Map<string, Element> } {
  const elementMap = new Map<string, Element>();
  const children: Record<string, AXNode> = {};
  const counts = new Map<string, number>();

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    null,
  );

  let el: Element | null;
  while ((el = walker.nextNode() as Element | null)) {
    if (!isInteractive(el)) continue;

    const key = keyIndex(el, counts);
    elementMap.set(key, el);
    const role = computeRole(el);

    const node: AXNode = { role };

    if (el instanceof HTMLInputElement) {
      node.value = el.value;
      node.affordance = CLICK_INPUT_TYPES.has(el.type) ? 'click' : 'input';
    } else if (el instanceof HTMLTextAreaElement) {
      node.value = el.value;
      node.affordance = 'input';
    } else if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') {
      node.affordance = 'input';
    } else {
      node.affordance = 'click';
    }

    const label = el.getAttribute('aria-label')
      || el.getAttribute('placeholder')
      || el.textContent?.trim().slice(0, 60)
      || '';
    if (label) node.name = label;

    children[key] = node;
  }

  return {
    axNode: { role: 'WebArea', name: document.title, children },
    elementMap,
  };
}

// ---------------------------------------------------------------------------
// Distill AX tree into PageState + OperationSchema
// Pure function — no DOM dependency, easily testable.
// Mirrors demo.ts ContentScript.distillAXTreeToSchema
// ---------------------------------------------------------------------------

export function distillAXTreeToSchema(
  axNode: AXNode,
): { scene: PageState; schema: OperationSchema } {
  const interactablePaths: string[] = [];

  for (const [key, node] of Object.entries(axNode.children ?? {})) {
    const basePointer = `/${key}`;
    if (node.affordance === 'input') {
      interactablePaths.push(`${basePointer}/value`);
    } else if (node.affordance === 'click') {
      interactablePaths.push(`${basePointer}/clicked`);
    }
  }

  const metadataMap = new Map<string, unknown>();
  metadataMap.set('scanTimestamp', new Date());
  metadataMap.set('interactiveNodeCount', interactablePaths.length);

  return {
    scene: {
      newInformation: [`Observed ${interactablePaths.length} interactive elements`],
      affordances: axNode.children ?? {},
      metadataMap,
    },
    schema: {
      allowedPaths: interactablePaths.length > 0 ? interactablePaths : ['/no-elements'],
      allowedOperations: ['replace'],
      description: "Apply 'replace' operations to interact with page elements. "
        + "Use /<el-key>/clicked to click, /<el-key>/value to set text.",
    },
  };
}
