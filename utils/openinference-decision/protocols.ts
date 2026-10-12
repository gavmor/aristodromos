// The decision APIs this repo can trace, one constant each. Everything that is
// the same between them (the bodies as input and output, `model`, and
// `usage.input_tokens` / `usage.output_tokens`) lives in attributes.ts; what is
// left to say per protocol is which endpoint it is and whose ecosystem it is.
// Part of the Apache-2.0 fork in this directory; see LICENSE and NOTICE here.
import { DecisionProvider, DecisionSystem } from '@arizeai/openinference-semantic-conventions';
import type { DecisionProtocol } from './trace';

/**
 * `POST <baseURL>/v1/systemone`, the Jev System One protocol, against any
 * compatible server: AutoJev/jev.cpp, jeff, laya. The spec's well-known system
 * for that shape is `typesafe`, whoever serves it. `decision.provider` is left
 * unset: the server is whatever `baseURL` points at, usually self-hosted, and
 * nothing in the protocol says who runs it. A caller that knows can spread this
 * and add one.
 */
export const JEV_SYSTEM_ONE: DecisionProtocol = {
  spanName: 'SystemOne',
  system: DecisionSystem.TYPESAFE,
  path: '/v1/systemone',
};

/**
 * `POST https://api.openai.com/v1/decisions`, the OpenAI Decisions API. The
 * system and the provider are both `openai`: only OpenAI serves it. Its usage
 * also carries `total_tokens` and `*_tokens_details`, which the decision span
 * conventions have no attribute for (a total is the sum of the two counts).
 */
export const OPENAI_DECISIONS: DecisionProtocol = {
  spanName: 'Decisions',
  system: DecisionSystem.OPENAI,
  provider: DecisionProvider.OPENAI,
  path: '/v1/decisions',
};
