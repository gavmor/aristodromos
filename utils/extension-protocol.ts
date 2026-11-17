// The extension's own channels: Port names and the DevTools panel's protocol.
// One long-lived `browser.runtime.connect` Port per content-script lifetime
// carries wire.ts's messages; its disconnect IS the lifecycle end — there is no
// separate teardown message to lose.
import type { ScenePatch } from '@gavmor/skene/core';

export const AGENT_PORT = 'aristodromos-agent';

/**
 * The DevTools panel's read-only view of one tab's Scene. The panel connects,
 * names its tab, and from then on receives exactly what that tab's frames send
 * up, each tagged with its frame: every frame's current Scene first, then every
 * snapshot and patch, and word when a frame goes away. The panel composes them
 * the same way the background does (TabScene).
 */
export const INSPECT_PORT = 'aristodromos-inspect';

/** panel -> background, once per connection */
export interface InspectRequest {
  kind: 'inspect';
  tabId: number;
}

/** background -> panel */
export type InspectMessage = { frameId: number; message: ScenePatch } | { frameId: number; gone: true };
