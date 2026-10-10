import { describe, expect, it } from 'vitest';
import { resolveRole } from '../utils/semantic-parser';
import { SceneProjector } from '../utils/scene-projector';
import type { StateNode } from '../utils/scene';

describe('roleless inputs', () => {
  it('names the inputs HTML-AAM leaves without a role', () => {
    document.body.innerHTML = `
      <input id="pw" type="password" />
      <input id="when" type="date" />
      <input id="text" type="text" />
      <input id="file" type="file" />`;
    const roleOf = (id: string) => resolveRole(document.getElementById(id)!);

    expect(roleOf('pw')).toBe('textbox');
    expect(roleOf('when')).toBe('textbox');
    expect(roleOf('text')).toBe('textbox');
    // not in the list, and not guessed at: still honestly role-less
    expect(roleOf('file')).toBeNull();
  });

  it('projects a password field as a settable state node, not a hole', () => {
    document.body.innerHTML = '<label for="pw">Password</label><input id="pw" type="password" />';
    const projector = new SceneProjector({ root: document, emit: () => {}, schedule: (cb) => cb() });
    projector.scan();

    const node = Object.values(projector.current.nodes).find((n) => n.name === 'Password') as StateNode | undefined;
    expect(node).toBeDefined();
    expect(node!.category).toBe('state');
    expect(node!.control).toBe('text');
  });
});
