// Minimal ambient types for @andypf/json-viewer (the package ships no .d.ts).
// Importing it registers the <andypf-json-viewer> custom element; these are
// the properties the panel sets on it.
interface JsonViewerElement extends HTMLElement {
  data: unknown;
  /** depth expanded on first render; `true` expands everything */
  expanded: number | boolean;
  indent: number;
  theme: string;
  /** keep each node's expanded/collapsed state when `data` changes */
  preserveExpanded: boolean;
  showDataTypes: boolean;
  showToolbar: boolean;
  showCopy: boolean;
  showSize: boolean;
}

interface HTMLElementTagNameMap {
  'andypf-json-viewer': JsonViewerElement;
}
