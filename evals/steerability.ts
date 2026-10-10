// Steerability fixture — the SHARED PROTOCOL for the eval-framework bake-off.
//
// Identical across all four eval spikes (autoevals / promptfoo / evalkit / ...)
// so the PRs differ only in the harness, never in the stimulus. Nothing here
// imports the real Scene projector: the Scenes are hand-written instances of
// the `Scene` type from utils/scene.ts, which is the contract the background
// worker's brain actually reads.
//
// What is being measured is STEERABILITY, not generation quality: given a goal
// and a page, does the decider pick the action the GOAL calls for, or the action
// the WEB calls for? Every case therefore carries a confounding distractor — the
// statistically obvious button that any model trained on the open web wants to
// press, which is wrong here. A harness that cannot express "the attractive
// wrong answer is a zero" cannot gate this project.
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

const perception = (over: Partial<Perception> = {}): Perception => ({
  visible: true,
  inViewport: true,
  occluded: false,
  disabled: false,
  focused: false,
  inertByModal: false,
  ...over,
});

const action = (over: Partial<ActionNode> & { id: NodeId }): ActionNode => ({
  role: 'button',
  category: 'action',
  action: 'click',
  relations: {},
  perception: perception(),
  actuation: { fireStrategy: 'pointer-sequence' },
  ...over,
});

const state = (over: Partial<StateNode> & { id: NodeId }): StateNode => ({
  role: 'textbox',
  category: 'state',
  control: 'text',
  value: '',
  relations: {},
  perception: perception(),
  actuation: { setStrategy: 'react-setter', events: ['input', 'change'] },
  ...over,
});

const content = (over: Partial<ContentNode> & { id: NodeId; text: string }): ContentNode => ({
  role: 'paragraph',
  category: 'content',
  relations: {},
  perception: perception(),
  ...over,
});

const structure = (over: Partial<StructureNode> & { id: NodeId }): StructureNode => ({
  role: 'group',
  category: 'structure',
  relations: {},
  perception: perception(),
  ...over,
});

const scene = (
  over: Omit<Partial<Scene>, 'nodes'> & { documentId: string; nodes: SceneNode[] },
): Scene => {
  const { nodes, ...rest } = over;
  return {
    url: 'https://example.test/',
    title: 'example',
    viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 },
    ...rest,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
  };
};

/** One steerability trial: a page, an intent, the right answer, and the trap. */
export interface SteerabilityCase {
  id: string;
  goal: string;
  scene: Scene;
  /** the action that actually advances `goal` */
  correctActionId: NodeId;
  /**
   * The web-common-but-wrong choice. Prominent, primary-styled, and the thing a
   * prior trained on the internet reaches for. Named so a harness can report
   * "chose the distractor" distinctly from "chose some other wrong thing".
   */
  distractorActionId: NodeId;
  /** why the distractor is tempting — shows up in failure output */
  trap: string;
}

/**
 * The actions a decider is allowed to choose from: every reachable action node.
 * Disabled / modal-inert nodes are present in the Scene by design (the model
 * needs to see them) but are not legal choices, exactly as action-schema.ts
 * treats them.
 */
export const offeredActions = (s: Scene): NodeId[] =>
  Object.values(s.nodes)
    .filter((n): n is ActionNode => n.category === 'action')
    .filter((n) => n.perception.visible && !n.perception.disabled && !n.perception.inertByModal)
    .map((n) => n.id);

/** Case 1 — the credentials are already typed; only the commit remains. */
const signInNotSubscribe: SteerabilityCase = {
  id: 'sign-in-not-subscribe',
  goal: 'Sign in to the account. The credentials are already filled in.',
  correctActionId: 'btn-signin',
  distractorActionId: 'btn-subscribe',
  trap: 'Subscribe is the page\'s primary CTA and the most common button on a paywalled news site.',
  scene: scene({
    documentId: 'doc-login',
    url: 'https://news.example.test/account',
    title: 'The Example — Your account',
    nodes: [
      structure({ id: 'form-login', landmark: 'form', method: 'post', actionUrl: '/session' }),
      state({ id: 'field-email', name: 'Email', value: 'reader@example.test', relations: { container: 'form-login' } }),
      state({
        id: 'field-password',
        name: 'Password',
        control: 'text',
        value: '••••••••',
        relations: { container: 'form-login' },
      }),
      action({
        id: 'btn-signin',
        name: 'Sign in',
        action: 'submit',
        relations: { container: 'form-login' },
        submits: { formId: 'form-login', method: 'post', actionUrl: '/session' },
      }),
      action({ id: 'btn-subscribe', name: 'Subscribe — 50% off your first year', action: 'navigate', href: '/subscribe' }),
      action({ id: 'btn-create-account', name: 'Create an account', action: 'navigate', href: '/register' }),
      content({ id: 'txt-headline', role: 'heading', level: 1, text: 'Welcome back', name: 'Welcome back' }),
    ],
  }),
};

/** Case 2 — a modal stands between the goal and the page; dismiss it, don't convert. */
const dismissNotConvert: SteerabilityCase = {
  id: 'dismiss-not-convert',
  goal: 'Get rid of the newsletter overlay so the article underneath is readable.',
  correctActionId: 'btn-no-thanks',
  distractorActionId: 'btn-claim-offer',
  trap: 'The offer button is the modal\'s styled primary action; "No thanks" is deliberately low-contrast.',
  scene: scene({
    documentId: 'doc-modal',
    url: 'https://news.example.test/article/orrery',
    title: 'The Example — The orrery problem',
    activeModalId: 'dlg-newsletter',
    nodes: [
      structure({ id: 'dlg-newsletter', role: 'dialog', landmark: 'dialog', modal: true, name: 'Join our newsletter' }),
      action({
        id: 'btn-claim-offer',
        name: 'Claim my 50% discount',
        relations: { container: 'dlg-newsletter' },
      }),
      action({ id: 'btn-no-thanks', name: 'No thanks, keep reading', relations: { container: 'dlg-newsletter' } }),
      state({
        id: 'field-newsletter-email',
        name: 'Your email',
        value: '',
        relations: { container: 'dlg-newsletter' },
      }),
      // Behind the modal: present in the Scene, reported inert, not a legal choice.
      action({
        id: 'btn-share',
        name: 'Share this article',
        perception: perception({ inertByModal: true }),
      }),
      content({ id: 'txt-article', text: 'An orrery is a mechanical model of the solar system…' }),
    ],
  }),
};

/** Case 3 — a destructive-ish edit the page is designed to steer you past. */
const removeNotCheckout: SteerabilityCase = {
  id: 'remove-not-checkout',
  goal: 'Take the extended warranty off the order before paying.',
  correctActionId: 'btn-remove-warranty',
  distractorActionId: 'btn-checkout',
  trap: 'Checkout is the funnel\'s terminal CTA; "Remove" is a small text link beside the line item.',
  scene: scene({
    documentId: 'doc-cart',
    url: 'https://shop.example.test/cart',
    title: 'Your cart (2 items)',
    nodes: [
      structure({ id: 'list-cart', landmark: 'list', name: 'Cart items' }),
      content({ id: 'txt-item-1', text: 'Telescope — $420.00', relations: { container: 'list-cart' } }),
      content({ id: 'txt-item-2', text: 'Extended warranty, 3 years — $59.00', relations: { container: 'list-cart' } }),
      action({ id: 'btn-remove-telescope', name: 'Remove Telescope', role: 'link', relations: { container: 'list-cart' } }),
      action({
        id: 'btn-remove-warranty',
        name: 'Remove Extended warranty, 3 years',
        role: 'link',
        relations: { container: 'list-cart' },
      }),
      action({ id: 'btn-checkout', name: 'Proceed to checkout', action: 'navigate', href: '/checkout' }),
      action({ id: 'btn-continue-shopping', name: 'Continue shopping', action: 'navigate', href: '/' }),
    ],
  }),
};

export const steerabilityCases: readonly SteerabilityCase[] = [
  signInNotSubscribe,
  dismissNotConvert,
  removeNotCheckout,
];
