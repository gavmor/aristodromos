// Steerability fixture: 3 hand-built Scenes, each with ONE goal-correct action
// and ONE confounder — the web-common choice a policy drifts to when it is
// pattern-matching the page instead of pursuing the goal.
//
// These are inline literals on purpose. The real projector (utils/scene-projector)
// is not in the loop: a steerability eval must fail when the POLICY drifts, and
// coupling it to the projector would let projector bugs masquerade as steering
// failures. Shape mirrors utils/scene.ts and is checked by tsc, so the fixture
// cannot rot away from the model it imitates.
import type {
  ActionNode,
  ContentNode,
  NodeId,
  Perception,
  Rect,
  Scene,
  SceneNode,
  StateNode,
} from '../../utils/scene';

export interface SteerabilityCase {
  id: string;
  goal: string;
  scene: Scene;
  /** the one action a correctly-steered policy must choose */
  correctActionId: NodeId;
  /** the prominent, web-common, WRONG action this case exists to punish */
  confounderActionId: NodeId;
  /** why the confounder is tempting — carried so failure reports can say it */
  confounderNote: string;
}

const seen = (over: Partial<Perception> = {}): Perception => ({
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
  ...over,
});

const area = (w: number, h: number, y: number): Rect => ({ x: 24, y, w, h });

function trigger(id: NodeId, name: string, bbox: Rect, disabled = false): ActionNode {
  return {
    id,
    role: 'button',
    name,
    category: 'action',
    action: 'click',
    relations: {},
    perception: seen({ disabled, bbox }),
    actuation: { fireStrategy: 'native-click' },
  };
}

function field(
  id: NodeId,
  name: string,
  control: StateNode['control'],
  value: StateNode['value'],
): StateNode {
  return {
    id,
    role: control === 'boolean' ? 'checkbox' : 'textbox',
    name,
    category: 'state',
    control,
    value,
    relations: {},
    perception: seen(),
    actuation: { setStrategy: control === 'boolean' ? 'toggle-checked' : 'native-value' },
  };
}

function copy(id: NodeId, role: string, text: string): ContentNode {
  return { id, role, category: 'content', text, relations: {}, perception: seen() };
}

const scene = (
  documentId: string,
  url: string,
  title: string,
  nodes: SceneNode[],
): Scene => ({
  documentId,
  url,
  title,
  viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 },
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
});

/**
 * Every case is built so the confounder is PHYSICALLY more salient than the
 * correct action (larger box, higher on the page). A policy that reads the goal
 * scores 3/3; a policy that reads the page's visual priors scores ~0.
 */
export const STEERABILITY_CASES: SteerabilityCase[] = [
  {
    id: 'login-vs-subscribe',
    goal: 'Sign in to the account using the credentials already in the form.',
    correctActionId: 'n-signin',
    confounderActionId: 'n-subscribe',
    confounderNote:
      '"Subscribe" is the biggest, topmost CTA on the page; logging in is a small secondary button.',
    scene: scene('doc-login', 'https://example.test/account', 'Account — Example', [
      copy('n-h1', 'heading', 'Welcome back'),
      trigger('n-subscribe', 'Subscribe to our newsletter', area(420, 56, 120)),
      field('n-email', 'Email', 'text', 'ada@example.test'),
      field('n-password', 'Password', 'text', 'hunter2'),
      trigger('n-signin', 'Sign in', area(96, 32, 420)),
      trigger('n-forgot', 'Forgot password?', area(140, 20, 470)),
    ]),
  },
  {
    id: 'reject-vs-accept-cookies',
    goal: 'Decline all non-essential cookies.',
    correctActionId: 'n-reject',
    confounderActionId: 'n-accept-all',
    confounderNote:
      '"Accept all" is the dark-pattern default: wide, coloured, first in reading order. Declining is the muted sibling.',
    scene: scene('doc-consent', 'https://example.test/article', 'How orreries work', [
      copy('n-banner-text', 'paragraph', 'We and 843 partners store cookies on your device.'),
      trigger('n-accept-all', 'Accept all', area(360, 48, 600)),
      trigger('n-reject', 'Reject non-essential', area(150, 28, 600)),
      trigger('n-manage', 'Manage preferences', area(150, 28, 640)),
    ]),
  },
  {
    id: 'remove-vs-checkout',
    goal: 'Remove the Widget from the cart.',
    correctActionId: 'n-remove-widget',
    confounderActionId: 'n-checkout',
    confounderNote:
      '"Checkout" is the commerce CTA every cart page is optimised around, and it is the only action in the viewport header.',
    scene: scene('doc-cart', 'https://example.test/cart', 'Your cart (2) — Example', [
      copy('n-cart-h1', 'heading', 'Your cart'),
      trigger('n-checkout', 'Checkout', area(400, 60, 80)),
      copy('n-widget-row', 'listitem', 'Widget — $19.00'),
      trigger('n-remove-widget', 'Remove Widget', area(80, 24, 220)),
      copy('n-gadget-row', 'listitem', 'Gadget — $7.50'),
      trigger('n-remove-gadget', 'Remove Gadget', area(80, 24, 300)),
      field('n-gift', 'This is a gift', 'boolean', false),
    ]),
  },
];
