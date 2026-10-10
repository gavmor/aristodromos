// Inlined minimal Scene fixture for the RunMesh spike: a login form.
//
// Deliberately hand-written rather than produced by the content-script projector
// — the spike must not depend on the projection pipeline. It is typed against
// the real `utils/scene.ts` contract so the tool wiring is proven against the
// actual up-edge shape, not a lookalike.
import type { Scene } from '../utils/scene';

const reachable = {
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
};

export const LOGIN_SCENE: Scene = {
  documentId: 'doc-spike-runmesh-1',
  url: 'https://example.test/login',
  title: 'Sign in — Example',
  lang: 'en',
  viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 },
  nodes: {
    loginForm: {
      id: 'loginForm',
      role: 'form',
      name: 'Sign in',
      category: 'structure',
      landmark: 'form',
      method: 'post',
      actionUrl: '/session',
      relations: {},
      perception: { ...reachable },
    },
    email: {
      id: 'email',
      role: 'textbox',
      name: 'Email address',
      category: 'state',
      control: 'text',
      value: '',
      required: true,
      placeholder: 'you@example.com',
      relations: { container: 'loginForm' },
      perception: { ...reachable },
      actuation: { setStrategy: 'native-value' },
    },
    signin: {
      id: 'signin',
      role: 'button',
      name: 'Sign in',
      category: 'action',
      action: 'click',
      relations: { container: 'loginForm' },
      perception: { ...reachable },
      actuation: { fireStrategy: 'native-click' },
    },
    cancel: {
      id: 'cancel',
      role: 'button',
      name: 'Cancel',
      category: 'action',
      action: 'click',
      relations: { container: 'loginForm' },
      perception: { ...reachable },
      actuation: { fireStrategy: 'native-click' },
    },
  },
};
