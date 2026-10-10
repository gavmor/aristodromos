// Minimal ambient types for aria-query (the package ships no .d.ts).
// We only consume the role taxonomy's superClass chains.
declare module 'aria-query' {
  export interface AriaRoleDefinition {
    superClass: string[][];
  }
  export interface AriaRoleMap {
    get(role: string): AriaRoleDefinition | undefined;
    keys(): IterableIterator<string>;
  }
  export const roles: AriaRoleMap;
}
