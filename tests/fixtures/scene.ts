// Scene builders shared by the System-One tests.
//
// Hand-built rather than projected, so a test can state exactly the one fact it
// is about (a disabled trigger, a read-only field) without a DOM in the way.
import type { ActionNode, Perception, Scene, SceneNode, StateNode, StructureNode } from '../../utils/scene';

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

export const sceneOf = (...nodes: SceneNode[]): Scene => ({
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

export const structureNode = (over: Partial<StructureNode> & { id: string }): StructureNode => ({
  role: 'form',
  category: 'structure',
  landmark: 'form',
  relations: {},
  perception: perception(),
  order: 0,
  ...over,
});

/** A select with two options, held in `container`. */
export const selectNode = (id: string, name: string, container: string, options: [string, string]): StateNode =>
  stateNode({
    id,
    name,
    role: 'combobox',
    control: 'option',
    value: options[0],
    options: options.map((o) => ({ value: o, label: o })),
    relations: { container },
    actuation: { setStrategy: 'select-option' },
  });

/**
 * A form with three selects and a Submit button — the minimal playbook. `extra`
 * nodes land in the same scene, to state the one fact a test is about.
 */
export const selectFormScene = (over: { submit?: Partial<ActionNode> } = {}, ...extra: SceneNode[]): Scene =>
  sceneOf(
    structureNode({ id: 'f1', name: 'Preferences' }),
    selectNode('s1', 'First', 'f1', ['a', 'b']),
    selectNode('s2', 'Second', 'f1', ['c', 'd']),
    selectNode('s3', 'Third', 'f1', ['e', 'f']),
    actionNode({ id: 'b1', name: 'Submit', action: 'submit', relations: { container: 'f1' }, ...over.submit }),
    ...extra,
  );
