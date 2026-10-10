import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentPort, type PortLike } from '../utils/content-port';
import type { Scene } from '../utils/scene';
import type { DownMessage, UpMessage } from '../utils/wire';

const scene: Scene = {
  documentId: 'd1',
  url: 'https://example.test/',
  title: 'test',
  viewport: { w: 800, h: 600, scrollX: 0, scrollY: 0 },
  nodes: {},
};
const snapshot: UpMessage = { kind: 'snapshot', scene };
const patch: UpMessage = { kind: 'patch', documentId: 'd1', ops: [] };

class FakePort implements PortLike {
  posted: UpMessage[] = [];
  disconnected = false;
  throwOnPost = false;
  private messageListeners: ((message: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];
  onMessage = { addListener: (listener: (message: unknown) => void) => void this.messageListeners.push(listener) };
  onDisconnect = { addListener: (listener: () => void) => void this.disconnectListeners.push(listener) };

  postMessage(message: UpMessage): void {
    if (this.throwOnPost) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(message);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  /** the other end went away: service-worker eviction, bfcache */
  drop(): void {
    for (const listener of this.disconnectListeners) listener();
  }
  deliver(message: DownMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

function harness(options: { invalid?: () => boolean } = {}) {
  const ports: FakePort[] = [];
  const received: DownMessage[] = [];
  let current: UpMessage | undefined = snapshot;
  const channel = new ContentPort({
    connect: () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    snapshot: () => current,
    onMessage: (message) => received.push(message),
    isInvalid: options.invalid ?? (() => false),
    reconnectMs: 100,
  });
  return { channel, ports, received, setSnapshot: (next: UpMessage | undefined) => (current = next) };
}

describe('ContentPort', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reconnects after the background drops the port, opening with a fresh snapshot', async () => {
    const { channel, ports } = harness();
    channel.open();
    expect(ports[0].posted).toEqual([snapshot]);

    ports[0].drop();
    channel.send(patch); // the replica is gone; this patch has nowhere to go
    await vi.advanceTimersByTimeAsync(100);

    expect(ports).toHaveLength(2);
    expect(ports[1].posted).toEqual([snapshot]);
    channel.send(patch);
    expect(ports[1].posted).toEqual([snapshot, patch]);
  });

  it('treats a postMessage that throws as a lost port, not a crash', async () => {
    const { channel, ports } = harness();
    channel.open();
    ports[0].throwOnPost = true;

    expect(() => channel.send(patch)).not.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    expect(ports).toHaveLength(2);
    expect(ports[1].posted).toEqual([snapshot]);
  });

  it('opens without a snapshot before the first scan, then sends the scan', () => {
    const { channel, ports, setSnapshot } = harness();
    setSnapshot(undefined);
    channel.open();
    expect(ports[0].posted).toEqual([]);
    channel.send(snapshot);
    expect(ports[0].posted).toEqual([snapshot]);
  });

  it('never holds two ports when open() races the reconnect timer', async () => {
    const { channel, ports } = harness();
    channel.open();
    ports[0].drop();
    channel.open(); // pageshow beat the reconnect timer
    await vi.advanceTimersByTimeAsync(100);
    expect(ports).toHaveLength(2);
  });

  it('ignores plans arriving on a port it has already replaced', async () => {
    const { channel, ports, received } = harness();
    channel.open();
    ports[0].drop();
    await vi.advanceTimersByTimeAsync(100);

    const idle: DownMessage = { kind: 'idle', documentId: 'd1', tick: 1, reason: 'x' };
    ports[0].deliver(idle);
    ports[1].deliver(idle);
    expect(received).toEqual([idle]);
  });

  it('goes quiet for good once the extension context is invalidated', async () => {
    let invalid = false;
    const { channel, ports } = harness({ invalid: () => invalid });
    channel.open();
    invalid = true;

    channel.send(patch);
    ports[0].drop();
    await vi.advanceTimersByTimeAsync(1000);
    channel.close();

    expect(ports).toHaveLength(1);
    expect(ports[0].posted).toEqual([snapshot]);
    expect(ports[0].disconnected).toBe(false); // touching it would throw
  });

  it('does not reconnect after close()', async () => {
    const { channel, ports } = harness();
    channel.open();
    channel.close();
    expect(ports[0].disconnected).toBe(true);
    ports[0].drop();
    channel.open();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ports).toHaveLength(1);
  });

  it('lets go of the port entering the back/forward cache and re-announces on restore', async () => {
    const { channel, ports } = harness();
    channel.open();

    channel.suspend();
    expect(ports[0].disconnected).toBe(true);
    ports[0].drop(); // Chrome's own close arriving late must not reconnect a cached page
    channel.send(patch);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ports).toHaveLength(1);

    channel.resume();
    expect(ports).toHaveLength(2);
    expect(ports[1].posted).toEqual([snapshot]);
  });

  it('tells a new background the old one already went idle on this exact scene', async () => {
    const { channel, ports } = harness();
    channel.open();
    ports[0].deliver({ kind: 'idle', documentId: 'd1', tick: 1, reason: 'goal met' });

    ports[0].drop(); // service worker evicted while idle
    await vi.advanceTimersByTimeAsync(100);
    expect(ports[1].posted).toEqual([{ ...snapshot, settled: true }]);
  });

  it('does not claim settled once the page moved, or after a plan', async () => {
    const { channel, ports } = harness();
    channel.open();
    ports[0].deliver({ kind: 'idle', documentId: 'd1', tick: 1, reason: 'goal met' });
    channel.send(patch); // the page moved after the idle answer
    ports[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(ports[1].posted).toEqual([snapshot]);

    ports[1].deliver({ kind: 'plan', documentId: 'd1', tick: 1, satisfied: '', remaining: 'x', actions: [{ kind: 'clickTrigger', nodeId: 'n1' }] });
    ports[1].drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(ports[2].posted).toEqual([snapshot]);
  });

  it('does not claim settled for a different document', async () => {
    const { channel, ports, setSnapshot } = harness();
    channel.open();
    ports[0].deliver({ kind: 'idle', documentId: 'd0', tick: 1, reason: 'goal met' });
    setSnapshot(snapshot);
    ports[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(ports[1].posted).toEqual([snapshot]);
  });
});
