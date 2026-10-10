// THROWAWAY SPIKE FIXTURE — a hand-written Scene standing in for the content
// script's live projection. Deliberately self-contained: only the *types* come
// from utils/scene.ts, no runtime dependency on the projection engine.
import type { Perception, Scene } from '../utils/scene';

const SEEN: Perception = {
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
};

/** A minimal login form: one text field + two triggers. */
export const LOGIN_SCENE: Scene = {
  documentId: 'spike-doc-1',
  url: 'https://example.test/login',
  title: 'Sign in — Example',
  viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 },
  nodes: {
    loginform: {
      id: 'loginform',
      role: 'form',
      name: 'Sign in',
      category: 'structure',
      landmark: 'form',
      method: 'post',
      relations: {},
      perception: SEEN,
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
      relations: { container: 'loginform' },
      perception: SEEN,
      actuation: { setStrategy: 'native-value' },
    },
    signin: {
      id: 'signin',
      role: 'button',
      name: 'Sign in',
      category: 'action',
      action: 'click',
      relations: { container: 'loginform' },
      perception: SEEN,
      actuation: { fireStrategy: 'native-click' },
    },
    cancel: {
      id: 'cancel',
      role: 'button',
      name: 'Cancel',
      category: 'action',
      action: 'click',
      relations: { container: 'loginform' },
      perception: SEEN,
      actuation: { fireStrategy: 'native-click' },
    },
  },
};
