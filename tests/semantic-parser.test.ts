import { describe, it, expect, beforeEach } from 'vitest';
import { parseNode, classifyCategory, ParseContext } from '../utils/semantic-parser';
import { NodeIdMirror } from '../utils/node-identity';

let ctx: ParseContext;
beforeEach(() => {
  document.body.innerHTML = '';
  ctx = { mirror: new NodeIdMirror() };
});

function first(sel: string): Element {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`no element for ${sel}`);
  return el;
}

describe('parseNode', () => {
  it('projects a text input as a convergent state node with label and value', () => {
    document.body.innerHTML = '<label for="e">Email</label><input id="e" type="text" value="a@b.com">';
    const node = parseNode(first('#e'), ctx);
    expect(node?.category).toBe('state');
    if (node?.category === 'state') {
      expect(node.control).toBe('text');
      expect(node.value).toBe('a@b.com');
      expect(node.actuation.setStrategy).toBe('react-setter');
    }
    expect(node?.name).toBe('Email');
  });

  it('projects a button as an action node with its accessible name', () => {
    document.body.innerHTML = '<button>Save</button>';
    const node = parseNode(first('button'), ctx);
    expect(node?.category).toBe('action');
    if (node?.category === 'action') expect(node.action).toBe('click');
    expect(node?.name).toBe('Save');
  });

  it('projects an anchor as a navigate action carrying its href', () => {
    document.body.innerHTML = '<a href="/next">Next</a>';
    const node = parseNode(first('a'), ctx);
    if (node?.category !== 'action') throw new Error('expected action');
    expect(node.action).toBe('navigate');
    expect(node.href).toBe('/next');
  });

  it('projects a heading as content with its level', () => {
    document.body.innerHTML = '<h2>Checkout</h2>';
    const node = parseNode(first('h2'), ctx);
    if (node?.category !== 'content') throw new Error('expected content');
    expect(node.level).toBe(2);
    expect(node.text).toBe('Checkout');
  });

  it('projects a checkbox as a boolean state node', () => {
    document.body.innerHTML = '<input type="checkbox" checked aria-label="Promo">';
    const node = parseNode(first('input'), ctx);
    if (node?.category !== 'state') throw new Error('expected state');
    expect(node.control).toBe('boolean');
    expect(node.value).toBe(true);
  });

  it('reports disabled in local perception', () => {
    document.body.innerHTML = '<button disabled>Pay</button>';
    const node = parseNode(first('button'), ctx);
    expect(node?.perception.disabled).toBe(true);
  });

  it('resolves aria-controls into the controlled node id and reads aria-expanded', () => {
    document.body.innerHTML =
      '<button aria-controls="panel" aria-expanded="false">More</button><div id="panel" role="region">x</div>';
    const panelId = ctx.mirror.idFor(first('#panel'));
    const node = parseNode(first('button'), ctx);
    expect(node?.relations.controls).toContain(panelId);
    if (node?.category === 'action') expect(node.expanded).toBe(false);
  });

  it('returns null for a semantically empty div', () => {
    document.body.innerHTML = '<div>just text</div>';
    expect(parseNode(first('div'), ctx)).toBeNull();
  });
});

describe('classifyCategory', () => {
  it('maps a landmark role to structure', () => {
    document.body.innerHTML = '<nav></nav>';
    expect(classifyCategory('navigation', first('nav'))).toBe('structure');
  });
});
