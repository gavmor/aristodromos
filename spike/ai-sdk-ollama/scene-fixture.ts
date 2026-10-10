// SPIKE FIXTURE — inline, self-contained. Deliberately NOT produced by the
// content-script projector: this spike only proves the *brain* wiring, so the
// observation is hand-written here.
//
// Only the TYPES come from utils/scene.ts (already on main). Importing them is
// the point: it proves the harness can speak the real up-edge contract without
// a translation layer, and `import type` erases at build time (zero runtime dep).
import type { ActionNode, Scene, StateNode, StructureNode } from '../../utils/scene';

const perception = {
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
};

const form: StructureNode = {
  id: 'loginForm',
  role: 'form',
  name: 'Sign in',
  category: 'structure',
  landmark: 'form',
  method: 'post',
  relations: {},
  perception,
};

const email: StateNode = {
  id: 'email',
  role: 'textbox',
  name: 'Email address',
  category: 'state',
  control: 'text',
  value: '',
  required: true,
  placeholder: 'you@example.com',
  relations: { container: 'loginForm' },
  perception,
  actuation: { setStrategy: 'native-value', events: ['input', 'change'] },
};

const signin: ActionNode = {
  id: 'signin',
  role: 'button',
  name: 'Sign in',
  category: 'action',
  action: 'submit',
  submits: { formId: 'loginForm', method: 'post' },
  relations: { container: 'loginForm' },
  perception,
  actuation: { fireStrategy: 'native-click' },
};

const cancel: ActionNode = {
  id: 'cancel',
  role: 'button',
  name: 'Cancel',
  category: 'action',
  action: 'click',
  relations: { container: 'loginForm' },
  perception,
  actuation: { fireStrategy: 'native-click' },
};

export const loginScene: Scene = {
  documentId: 'doc-spike-1',
  url: 'https://example.test/login',
  title: 'Sign in — Example',
  lang: 'en',
  viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 },
  nodes: {
    loginForm: form,
    email,
    signin,
    cancel,
  },
};
