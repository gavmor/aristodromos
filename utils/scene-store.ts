// The background's replica of the page.
//
// The content script owns the authoritative Scene; this is the derived copy the
// policy reasons over, rebuilt from the same `ScenePatch` stream. Keeping it a
// plain fold (snapshot, then ops) means the background holds no state the
// content script cannot reconstruct by reconnecting.
import { applyPatch } from 'fast-json-patch';
import type { Scene, ScenePatch } from './scene';

export class SceneStore {
  private scene: Scene | null = null;

  get current(): Scene | null {
    return this.scene;
  }

  /**
   * Fold one up-edge message in. Returns the Scene if it advanced, else null.
   *
   * A patch for a documentId we do not hold is DROPPED, not applied blind: it
   * means a navigation raced ahead of us and a fresh snapshot is already in
   * flight. Dropping is safe precisely because the loop is memoryless — the next
   * snapshot is the whole truth.
   */
  ingest(message: ScenePatch): Scene | null {
    if (message.kind === 'snapshot') {
      this.scene = message.scene;
      return this.scene;
    }
    if (!this.scene || this.scene.documentId !== message.documentId) return null;
    this.scene = applyPatch(this.scene, message.ops, false, true).newDocument;
    return this.scene;
  }

  reset(): void {
    this.scene = null;
  }
}
