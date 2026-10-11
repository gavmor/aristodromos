// Scene builders shared by the System-One tests.
//
// Hand-built rather than projected, so a test can state exactly the one fact it
// is about (a disabled trigger, a read-only field) without a DOM in the way.
import type { ActionNode, Perception, Scene, StateNode } from '../../utils/scene';

export const perception = (over: Partial<Perception> = {}): Perception => ({
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
  ...over,
});

export const stateNode = (over: Partial<StateNode> & { id: string }): StateNode => ({
  role: 'textbox',
  category: 'state',
  control: 'text',
  value: '',
  relations: {},
  perception: perception(),
  actuation: { setStrategy: 'react-setter', events: ['input', 'change'] },
  order: 0,
  ...over,
});

export const actionNode = (over: Partial<ActionNode> & { id: string }): ActionNode => ({
  role: 'button',
  category: 'action',
  action: 'click',
  relations: {},
  perception: perception(),
  actuation: { fireStrategy: 'pointer-sequence' },
  order: 0,
  ...over,
});

export const sceneOf = (...nodes: (StateNode | ActionNode)[]): Scene => ({
  documentId: 'doc1',
  url: 'https://example.test/',
  title: 'test',
  viewport: { w: 800, h: 600, scrollX: 0, scrollY: 0 },
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
});

/** The e2e login fixture's shape: two text fields, a checkbox, a disabled submit. */
export const loginScene = (over: { submitEnabled?: boolean; email?: string } = {}): Scene =>
  sceneOf(
    stateNode({ id: 'n1', name: 'Email address', value: over.email ?? '' }),
    stateNode({ id: 'n2', name: 'Password', value: '' }),
    stateNode({
      id: 'n3',
      name: 'Remember this device',
      role: 'checkbox',
      control: 'boolean',
      value: false,
      actuation: { setStrategy: 'toggle-checked' },
    }),
    actionNode({
      id: 'n4',
      name: 'Sign in',
      action: 'submit',
      perception: perception({ disabled: !over.submitEnabled }),
    }),
  );
