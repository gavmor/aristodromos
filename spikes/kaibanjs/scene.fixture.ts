// THROWAWAY SPIKE FIXTURE — not production code.
//
// A minimal, inline Scene: one login form with a single text input and two
// triggers. Deliberately NOT imported from the content branch; the shape mirrors
// utils/scene.ts so the harness is exercised against the real up-edge contract.
import type { Scene } from '../../utils/scene';

export const LOGIN_SCENE: Scene = {
  documentId: 'doc-spike-1',
  url: 'https://example.test/login',
  title: 'Sign in — Example',
  lang: 'en',
  viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 },
  nodes: {
    form: {
      id: 'form',
      role: 'form',
      name: 'Sign in',
      category: 'structure',
      landmark: 'form',
      method: 'post',
      relations: {},
      perception: {
        visible: true,
        inViewport: true,
        occluded: false,
        disabled: false,
        focused: false,
        inertByModal: false,
      },
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
      relations: { container: 'form' },
      perception: {
        visible: true,
        inViewport: true,
        occluded: false,
        disabled: false,
        focused: true,
        inertByModal: false,
      },
      actuation: { setStrategy: 'native-value', fireStrategy: 'native-click' },
    },
    signin: {
      id: 'signin',
      role: 'button',
      name: 'Sign in',
      category: 'action',
      action: 'click',
      relations: { container: 'form' },
      perception: {
        visible: true,
        inViewport: true,
        occluded: false,
        disabled: false,
        focused: false,
        inertByModal: false,
      },
      actuation: { fireStrategy: 'native-click' },
    },
    cancel: {
      id: 'cancel',
      role: 'button',
      name: 'Cancel',
      category: 'action',
      action: 'click',
      relations: { container: 'form' },
      perception: {
        visible: true,
        inViewport: true,
        occluded: false,
        disabled: false,
        focused: false,
        inertByModal: false,
      },
      actuation: { fireStrategy: 'native-click' },
    },
  },
};
