// THROWAWAY SPIKE FIXTURE — inlined so this branch does not depend on the
// content-script projection work. Shape mirrors utils/scene.ts exactly.
import type {
  ActionNode,
  Perception,
  Scene,
  StateNode,
  StructureNode,
} from '../../utils/scene';

const reachable = (overrides: Partial<Perception> = {}): Perception => ({
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
  ...overrides,
});

const loginForm: StructureNode = {
  id: 'loginForm',
  role: 'form',
  name: 'Sign in',
  category: 'structure',
  landmark: 'form',
  method: 'post',
  actionUrl: '/session',
  relations: {},
  perception: reachable(),
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
  perception: reachable({ focused: true }),
  actuation: { setStrategy: 'native-value', events: ['input', 'change'] },
};

const signin: ActionNode = {
  id: 'signin',
  role: 'button',
  name: 'Sign in',
  category: 'action',
  action: 'click',
  submits: { formId: 'loginForm', method: 'post', actionUrl: '/session' },
  relations: { container: 'loginForm' },
  perception: reachable(),
  actuation: { fireStrategy: 'native-click' },
};

const cancel: ActionNode = {
  id: 'cancel',
  role: 'button',
  name: 'Cancel',
  category: 'action',
  action: 'click',
  relations: { container: 'loginForm' },
  perception: reachable(),
  actuation: { fireStrategy: 'native-click' },
};

export const loginScene: Scene = {
  documentId: 'spike-doc-1',
  url: 'https://example.test/login',
  title: 'Sign in — Example',
  lang: 'en',
  viewport: { w: 1280, h: 720, scrollX: 0, scrollY: 0 },
  focusedId: 'email',
  nodes: { loginForm, email, signin, cancel },
};
