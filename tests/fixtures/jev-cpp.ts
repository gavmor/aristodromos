import type { SystemOneRequest } from '../../utils/system-one';

/**
 * Verbatim body from a REAL `POST /v1/systemone` against jev.cpp serving
 * autojev-27b (Concourse build 782125, autojev/autojev-session#1). Pinning the
 * observed bytes rather than a guessed shape is the whole point: a client, or a
 * span, is only correct if it reads what a server actually sends.
 */
export const OBSERVED = {
  model: 'autojev-qwen3.8-27b',
  answers: {
    route: {
      type: 'choice',
      probabilities: { payments: 0.9754878093326114, account: 0.014168012148653977, other: 0.01034417851873474 },
      choice: 'payments',
      confidence: 0.963231713998917,
    },
    urgent: { type: 'noul', noul: 0.6399575419561028 },
  },
  usage: { input_tokens: 202, output_tokens: 0 },
};

/** The request that body answered. */
export const REQUEST: SystemOneRequest = {
  model: 'autojev',
  state: 'Three payouts failed, but login still works.',
  questions: {
    route: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { payments: 'Payout failures and billing', account: 'Login and account access', other: 'Anything else' },
    },
    urgent: { type: 'noul', instructions: 'Does this need urgent attention?' },
  },
};
