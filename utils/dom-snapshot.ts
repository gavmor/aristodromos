import type { AXNode, PageState, OperationSchema } from './types';

// ---------------------------------------------------------------------------
// Build AX tree from live DOM — mirrors demo.ts ContentScript.fetchRealSceneContext
// ---------------------------------------------------------------------------

export function buildAXTree(): { axNode: AXNode; elementMap: Map<string, Element> } {
  const elementMap = new Map<string, Element>();

  const interactives = document.querySelectorAll<HTMLElement>(
    'button, a, input, textarea, select, [tabindex]:not([tabindex="-1"])',
  );

  const children: Record<string, AXNode> = {};

  interactives.forEach((el, i) => {
    const key = `el-${el.tagName.toLowerCase()}-${i}`;
    elementMap.set(key, el);

    const node: AXNode = { role: el.getAttribute('role') ?? el.tagName.toLowerCase() };

    if (el instanceof HTMLInputElement) {
      node.role = el.type === 'checkbox' ? 'checkbox' : el.type === 'submit' ? 'button' : 'textbox';
      node.value = el.value;
    } else if (el instanceof HTMLTextAreaElement) {
      node.role = 'textbox';
      node.value = el.value;
    }

    const label = el.getAttribute('aria-label')
      || el.getAttribute('placeholder')
      || el.textContent?.trim().slice(0, 60)
      || '';
    if (label) node.name = label;

    children[key] = node;
  });

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
    if (node.role === 'button' || node.role === 'checkbox') {
      interactablePaths.push(`${basePointer}/clicked`);
    } else if (node.role === 'textbox' || node.role === 'input') {
      interactablePaths.push(`${basePointer}/value`);
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
