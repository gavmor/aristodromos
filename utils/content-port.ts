// The content script's end of the agent Port, kept open across the things that
// close it underneath us: the MV3 service worker being evicted, and the page
// entering the back/forward cache. Either way the background has lost its
// replica, so every new connection opens with a full Scene snapshot; patches
// sent while disconnected are simply not sent, because that snapshot supersedes
// them.
//
// The one thing that cannot be survived is an invalidated extension context
// (the extension was reloaded or removed). From then on nothing is sent and
// nothing reconnects; only a page reload brings in the new content script.
//
// No browser API in here, so it can be driven by tests; the content script
// supplies `connect`.
import type { DownMessage, UpMessage } from './wire';

/** The slice of `browser.runtime.Port` this module uses. */
export interface PortLike {
  postMessage(message: UpMessage): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface ContentPortDeps {
  connect: () => PortLike;
  /** the current Scene, announced on every new connection; undefined before the first scan */
  snapshot: () => UpMessage | undefined;
  onMessage: (message: DownMessage) => void;
  /** true once the extension context is gone for good */
  isInvalid: () => boolean;
  /** pause before reconnecting, so a port that keeps dropping cannot spin */
  reconnectMs?: number;
}

export class ContentPort {
  private port: PortLike | undefined;
  private reconnectTimer: number | undefined;
  private closed = false;
  /** in the back/forward cache: no port, no reconnecting, until `resume` */
  private suspended = false;
  /** the document the background last went idle on, with nothing sent up since */
  private idleOn: string | undefined;

  constructor(private deps: ContentPortDeps) {}

  /**
   * Connect if not connected, and announce the current Scene. If the previous
   * background had already gone idle on exactly this Scene, the announcement
   * says so, and the new one does not decide on it all over again.
   */
  open(): void {
    if (this.closed || this.suspended || this.port || this.deps.isInvalid()) return;
    const port = this.deps.connect();
    this.port = port;
    port.onMessage.addListener((message) => {
      if (this.port !== port) return;
      const down = message as DownMessage;
      this.idleOn = down.kind === 'idle' ? down.documentId : undefined;
      this.deps.onMessage(down);
    });
    port.onDisconnect.addListener(() => this.lost(port));
    const snapshot = this.deps.snapshot();
    if (!snapshot) return;
    const settled = snapshot.kind === 'snapshot' && snapshot.scene.documentId === this.idleOn;
    this.post(port, settled ? { ...snapshot, settled: true } : snapshot);
  }

  send(message: UpMessage): void {
    // Anything sent up means the Scene moved (or is being re-offered): not idle.
    this.idleOn = undefined;
    const port = this.port;
    if (port) this.post(port, message);
  }

  private post(port: PortLike, message: UpMessage): void {
    if (this.deps.isInvalid()) return;
    try {
      port.postMessage(message);
    } catch {
      // The port died before its onDisconnect reached us; same recovery.
      this.lost(port);
    }
  }

  /**
   * The page is entering the back/forward cache, which closes the Port without
   * telling a page that then sits idle. Let go of it ourselves.
   */
  suspend(): void {
    this.suspended = true;
    this.release();
  }

  /** Restored from the back/forward cache: a fresh Port, and a fresh snapshot on it. */
  resume(): void {
    this.suspended = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    this.release();
  }

  private release(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const port = this.port;
    this.port = undefined;
    // Touching a port of an invalidated context throws; it is already dead.
    if (port && !this.deps.isInvalid()) port.disconnect();
  }

  private lost(port: PortLike): void {
    if (this.port !== port) return;
    this.port = undefined;
    if (this.closed || this.suspended || this.deps.isInvalid() || this.reconnectTimer !== undefined) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, this.deps.reconnectMs ?? 250);
  }
}
