// The content script's down-edge: what one DownMessage does to the page.
//
// Lives apart from the WXT entrypoint so the integration tests drive the very
// same code the extension runs, not a copy of it.
import type { SceneProjector } from './scene-projector';
import type { ScenePatch } from './scene';
import { applyPlan, didMove, summarize } from './reconciler';
import type { DownMessage } from './wire';

/** `log` hears one line per message handled; silent unless the host wires it. */
export function handlePlan(
  projector: SceneProjector,
  message: DownMessage,
  send: (patch: ScenePatch) => void,
  log: (line: string) => void = () => {},
): void {
  if (message.kind === 'idle') {
    log(`[agent] tick ${message.tick} idle: ${message.reason}`);
    return;
  }
  // A plan for a document we have navigated away from is discarded; the
  // snapshot for the new document is already on the wire.
  if (message.documentId !== projector.current.documentId) {
    log(`[agent] tick ${message.tick} dropped: plan for a stale document`);
    return;
  }
  const results = applyPlan(message.actions, {
    resolve: (id) => projector.elementFor(id),
    nodeOf: (id) => projector.nodeOf(id),
  });
  log(`[agent] tick ${message.tick} remaining=${JSON.stringify(message.remaining)} -> ${summarize(results)}`);

  // The plan changed nothing, so the projector has nothing to report, so the
  // background would hear silence and conclude we are finished. We are not —
  // it stalled. Re-offer the same Scene and let it decide again; the tick
  // budget bounds how long it may keep stalling.
  if (!didMove(results)) {
    log(`[agent] tick ${message.tick} moved nothing — re-offering the scene`);
    send(projector.snapshot());
  }
}
