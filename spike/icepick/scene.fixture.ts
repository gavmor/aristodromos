// THROWAWAY SPIKE FIXTURE — inlined on purpose so this branch does not depend on
// the content-script branch. Shape mirrors utils/scene.ts exactly.
//
// A minimal login form: one text input (`email`) plus two triggers
// (`signin`, `cancel`), inside a form landmark.
import type { Scene, ActionNode, StateNode } from '../../utils/scene';

const perception = {
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
};

export const LOGIN_SCENE: Scene = {
  documentId: 'doc-spike-1',
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
      perception: { ...perception },
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
      perception: { ...perception },
      actuation: { setStrategy: 'native-value', events: ['input', 'change'] },
    },
    signin: {
      id: 'signin',
      role: 'button',
      name: 'Sign in',
      category: 'action',
      action: 'submit',
      submits: { formId: 'loginForm', method: 'post', actionUrl: '/session' },
      relations: { container: 'loginForm' },
      perception: { ...perception },
      actuation: { fireStrategy: 'native-click' },
    },
    cancel: {
      id: 'cancel',
      role: 'button',
      name: 'Cancel',
      category: 'action',
      action: 'click',
      relations: { container: 'loginForm' },
      perception: { ...perception },
      actuation: { fireStrategy: 'native-click' },
    },
  },
};

/** Scene node ids the policy may `setState` on. Tools map 1:1 onto these. */
export function stateNodeIds(scene: Scene): string[] {
  return Object.values(scene.nodes)
    .filter((n): n is StateNode => n.category === 'state')
    .map((n) => n.id);
}

/** Scene node ids the policy may `clickTrigger` on. Tools map 1:1 onto these. */
export function actionNodeIds(scene: Scene): string[] {
  return Object.values(scene.nodes)
    .filter((n): n is ActionNode => n.category === 'action')
    .map((n) => n.id);
}

/** Flat, promptable rendering of the Scene — what the brain actually reasons over. */
export function describeScene(scene: Scene): string {
  const lines = Object.values(scene.nodes).map((n) => {
    const base = `- id=${n.id} role=${n.role} name=${JSON.stringify(n.name ?? '')} category=${n.category}`;
    if (n.category === 'state') return `${base} control=${n.control} value=${JSON.stringify(n.value)}`;
    if (n.category === 'action') return `${base} action=${n.action}`;
    return base;
  });
  return `Page "${scene.title}" at ${scene.url}\n${lines.join('\n')}`;
}
