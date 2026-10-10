// Minimal ambient types for jsdom, following the same pattern as
// utils/aria-query.d.ts. The probe needs one constructor and one property, so a
// four-line surface beats pulling in @types/jsdom for a file that is not part of
// any gate.
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string;
    /** 'dangerously' is what makes the fixture's own inline <script> run */
    runScripts?: 'dangerously' | 'outside-only';
  }
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
  }
}
