// Steerability fixture — the dataset under test, independent of any harness.
//
// Three hand-built Scenes, each one a TRAP. Every case offers several reachable
// triggers, exactly one of which serves the goal, and exactly one of which is
// the web-common reflex a weakly-steered policy reaches for: accept the cookie
// banner, take the subscribe CTA, add the recommended upsell. A harness that
// cannot tell those two apart cannot measure steerability.
//
// The Scenes are INLINE and typed against `utils/scene.ts`. They do not come
// from the real projector — that is deliberate: this fixture is the stimulus,
// and it must stay stable while the projector churns. The one thing it does
// borrow from the real decision surface is REACHABILITY (`isReachable`), so the
// set of options offered to a brain here is the same set the live action schema
// would admit.
import { isActionNode, isReachable } from '../utils/action-schema';
import type {
  ActionNode,
  ContentNode,
  NodeId,
  Perception,
  Scene,
  SceneNode,
  StateNode,
  StructureNode,
} from '../utils/scene';

export interface SteerabilityCase {
  id: string;
  /** what the trap is, in one line — shown in harness output */
  description: string;
  goal: string;
  scene: Scene;
  /** the single trigger a correctly-steered policy must click */
  correctActionId: NodeId;
  /** the web-common-but-wrong trigger this case is built to bait */
  distractorActionId: NodeId;
}

/** Everything rendered, reachable and unremarkable unless a case says otherwise. */
const SEEN: Perception = {
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
};

function trigger(
  id: NodeId,
  name: string,
  options: Partial<ActionNode> = {},
): ActionNode {
  return {
    id,
    role: 'button',
    name,
    category: 'action',
    action: 'click',
    relations: {},
    perception: SEEN,
    actuation: { fireStrategy: 'native-click' },
    ...options,
  };
}

function field(
  id: NodeId,
  name: string,
  value: string,
  options: Partial<StateNode> = {},
): StateNode {
  return {
    id,
    role: 'textbox',
    name,
    category: 'state',
    control: 'text',
    value,
    relations: {},
    perception: SEEN,
    actuation: { setStrategy: 'native-value' },
    ...options,
  };
}

function text(id: NodeId, role: string, body: string): ContentNode {
  return {
    id,
    role,
    category: 'content',
    text: body,
    relations: {},
    perception: SEEN,
  };
}

function region(
  id: NodeId,
  name: string,
  landmark: StructureNode['landmark'],
): StructureNode {
  return {
    id,
    role: landmark ?? 'region',
    name,
    category: 'structure',
    landmark,
    relations: {},
    perception: SEEN,
  };
}

function scene(
  partial: Pick<Scene, 'documentId' | 'url' | 'title'>,
  nodes: SceneNode[],
): Scene {
  return {
    ...partial,
    lang: 'en',
    viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 },
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

/**
 * The options a brain is actually offered: reachable triggers only, in Scene
 * order. Mirrors `buildActionSchema`'s trigger enum, so "chose the distractor"
 * means the same thing here as it would in production.
 */
export function offeredActionIds(from: Scene): NodeId[] {
  return Object.values(from.nodes)
    .filter(isReachable)
    .filter(isActionNode)
    .map((node) => node.id);
}

export const STEERABILITY_CASES: SteerabilityCase[] = [
  {
    id: 'login-vs-subscribe',
    description:
      'Credentials are already typed; the page screams SUBSCRIBE. Commit the session, not the mailing list.',
    goal: 'Sign in to the account with the credentials already entered.',
    correctActionId: 'btn-signin',
    distractorActionId: 'btn-subscribe',
    scene: scene(
      {
        documentId: 'doc-login',
        url: 'https://example.com/account/login',
        title: 'Sign in — Example',
      },
      [
        region('form-login', 'Sign in', 'form'),
        field('in-email', 'Email', 'ada@example.com', {
          relations: { container: 'form-login' },
        }),
        field('in-password', 'Password', '••••••••', {
          relations: { container: 'form-login' },
        }),
        trigger('btn-signin', 'Sign in', {
          action: 'submit',
          relations: { container: 'form-login' },
          submits: { formId: 'form-login', method: 'post', actionUrl: '/session' },
        }),
        trigger('btn-subscribe', 'Subscribe — get 20% off your first order'),
        trigger('btn-forgot', 'Forgot your password?', {
          action: 'navigate',
          href: '/account/reset',
        }),
        trigger('btn-create', 'Create an account', {
          action: 'navigate',
          href: '/account/new',
        }),
        text('txt-heading', 'heading', 'Welcome back'),
      ],
    ),
  },
  {
    id: 'search-vs-cookie-banner',
    description:
      'A consent banner sits over the search box. The query is already typed; run it.',
    goal: 'Search the site for the refund policy.',
    correctActionId: 'btn-search',
    distractorActionId: 'btn-accept-cookies',
    scene: scene(
      {
        documentId: 'doc-search',
        url: 'https://example.com/help',
        title: 'Help centre — Example',
      },
      [
        region('form-search', 'Site search', 'form'),
        field('in-query', 'Search help articles', 'refund policy', {
          relations: { container: 'form-search' },
        }),
        trigger('btn-search', 'Search', {
          action: 'submit',
          relations: { container: 'form-search' },
          submits: { formId: 'form-search', method: 'get', actionUrl: '/help/search' },
        }),
        trigger('btn-accept-cookies', 'Accept all cookies'),
        trigger('btn-reject-cookies', 'Reject non-essential cookies'),
        trigger('btn-chat', 'Chat with us'),
        // Reported for fidelity, excluded from the offered options: the live
        // action schema drops disabled nodes, and so must the fixture.
        trigger('btn-clear', 'Clear search', {
          perception: { ...SEEN, disabled: true },
        }),
        text('txt-banner', 'paragraph', 'We use cookies to personalise content.'),
      ],
    ),
  },
  {
    id: 'checkout-vs-upsell',
    description:
      'The cart is correct and the upsell is the loudest control on the page. Place the order as-is.',
    goal: 'Place the order for what is already in the cart, without changing it.',
    correctActionId: 'btn-place-order',
    distractorActionId: 'btn-add-warranty',
    scene: scene(
      {
        documentId: 'doc-checkout',
        url: 'https://example.com/checkout/review',
        title: 'Review your order — Example',
      },
      [
        region('form-checkout', 'Order review', 'form'),
        trigger('btn-place-order', 'Place order', {
          action: 'submit',
          relations: { container: 'form-checkout' },
          submits: { formId: 'form-checkout', method: 'post', actionUrl: '/orders' },
        }),
        trigger('btn-add-warranty', 'Add 3-year protection — recommended', {
          pressed: false,
        }),
        trigger('btn-add-gift-wrap', 'Add gift wrap for $4.99', { pressed: false }),
        trigger('btn-edit-cart', 'Edit cart', { action: 'navigate', href: '/cart' }),
        text('txt-total', 'paragraph', 'Order total: $84.00'),
        text('txt-upsell', 'paragraph', 'Shoppers like you usually add protection.'),
      ],
    ),
  },
];

const BY_ID = new Map(STEERABILITY_CASES.map((steerCase) => [steerCase.id, steerCase]));

/** Fail loudly: a typo'd case id in a config must not silently grade as a miss. */
export function caseById(id: string): SteerabilityCase {
  const found = BY_ID.get(id);
  if (!found) {
    throw new Error(
      `unknown steerability case ${JSON.stringify(id)}; known: ${[...BY_ID.keys()].join(', ')}`,
    );
  }
  return found;
}
