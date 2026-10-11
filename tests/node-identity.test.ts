import { describe, it, expect, beforeEach } from 'vitest';
import { NodeIdMirror, structuralPath, semanticSignature } from '../utils/node-identity';

describe('NodeIdMirror', () => {
  let mirror: NodeIdMirror;
  beforeEach(() => {
    mirror = new NodeIdMirror();
    document.body.innerHTML = '';
  });

  it('mints a stable id and reuses it for the same element', () => {
    const el = document.createElement('button');
    const id = mirror.idFor(el);
    expect(id).toBe(mirror.idFor(el));
    expect(mirror.peek(el)).toBe(id);
  });

  it('gives different ids to different elements', () => {
    const a = document.createElement('button');
    const b = document.createElement('button');
    expect(mirror.idFor(a)).not.toBe(mirror.idFor(b));
  });

  it('re-keys the same NodeId to a new element sharing a signature', () => {
    const sig = 'button|Save|body:1/button:1';
    const first = document.createElement('button');
    const id = mirror.idFor(first, sig);
    const remounted = document.createElement('button');
    expect(mirror.idFor(remounted, sig)).toBe(id);
  });

  it('never hands a live element\u2019s id to another element with its signature', () => {
    // An unnamed list item inserted at position 2 has the old signature of the item it pushed down.
    const sig = 'listitem||body:1/ul:1/li:2';
    const live = document.body.appendChild(document.createElement('li'));
    const id = mirror.idFor(live, sig);
    const newcomer = document.body.appendChild(document.createElement('li'));
    expect(mirror.idFor(newcomer, sig)).not.toBe(id);
    expect(mirror.elementFor(id)).toBe(live);
  });

  it('peek returns undefined for untracked elements', () => {
    expect(mirror.peek(document.createElement('div'))).toBeUndefined();
  });
});

describe('structuralPath', () => {
  it('encodes a tag + nth-of-type chain', () => {
    document.body.innerHTML = '<main><button>a</button><button>b</button></main>';
    const second = document.querySelectorAll('button')[1];
    const path = structuralPath(second);
    expect(path).toContain('button:2');
    expect(path).toContain('main:1');
  });
});

describe('semanticSignature', () => {
  it('joins role, name and path, tolerating a missing name', () => {
    expect(semanticSignature('button', 'Save', 'p')).toBe('button|Save|p');
    expect(semanticSignature('button', undefined, 'p')).toBe('button||p');
  });
});
