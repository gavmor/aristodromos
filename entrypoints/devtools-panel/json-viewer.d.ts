// Minimal ambient types for @andypf/json-viewer (the package ships no .d.ts).
// Importing it registers the <andypf-json-viewer> custom element; these are
// the properties the panel sets on it, as DOM properties and as JSX props.
import 'preact';

interface JsonViewerProperties {
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

declare global {
  interface HTMLElementTagNameMap {
    'andypf-json-viewer': HTMLElement & JsonViewerProperties;
  }
}

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'andypf-json-viewer': HTMLAttributes<HTMLElement> & Partial<JsonViewerProperties>;
    }
  }
}
