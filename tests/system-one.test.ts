import { describe, expect, it, vi } from 'vitest';
import { askSystemOne, isChoiceAnswer, isNoulAnswer, type SystemOneRequest } from '../utils/system-one';

/**
 * Verbatim body from a REAL `POST /v1/systemone` against jev.cpp serving
 * autojev-27b (Concourse build 782125, autojev/autojev-session#1). Pinning the
 * observed bytes rather than a guessed shape is the whole point of this test:
 * the client is only correct if it parses what a server actually sends.
 */
const OBSERVED = {
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

const REQUEST: SystemOneRequest = {
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

const ok = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

describe('askSystemOne', () => {
  it('POSTs the request body to <baseURL>/v1/systemone', async () => {
    const fetchImpl = ok(OBSERVED);
    await askSystemOne({ baseURL: 'http://localhost:18080', request: REQUEST, fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:18080/v1/systemone');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(REQUEST);
  });

  it('tolerates a trailing slash on the base URL', async () => {
    const fetchImpl = ok(OBSERVED);
    await askSystemOne({ baseURL: 'http://localhost:18080/', request: REQUEST, fetchImpl });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('http://localhost:18080/v1/systemone');
  });

  it('reads a real response: the winning label, its distribution, and P(yes)', async () => {
    const response = await askSystemOne({ baseURL: 'http://x', request: REQUEST, fetchImpl: ok(OBSERVED) });

    const route = response.answers.route;
    expect(isChoiceAnswer(route)).toBe(true);
    if (!isChoiceAnswer(route)) throw new Error('unreachable');
    expect(route.choice).toBe('payments');
    expect(route.probabilities.payments).toBeCloseTo(0.9755, 4);
    expect(route.confidence).toBeCloseTo(0.9632, 4);

    const urgent = response.answers.urgent;
    expect(isNoulAnswer(urgent)).toBe(true);
    if (!isNoulAnswer(urgent)) throw new Error('unreachable');
    expect(urgent.noul).toBeCloseTo(0.64, 2);
  });

  it('is the SERVER confidence, not a client recomputation', () => {
    // The protocol note quotes `1 - H(p)/ln K`; this server does not use it.
    // Both are computed here so the discrepancy is recorded rather than assumed.
    const p = Object.values(OBSERVED.answers.route.probabilities);
    const entropyForm = 1 + p.reduce((h, x) => h + x * Math.log(x), 0) / Math.log(p.length);
    const scaledMax = (Math.max(...p) - 1 / p.length) / (1 - 1 / p.length);

    expect(entropyForm).toBeCloseTo(0.88, 2);
    expect(scaledMax).toBeCloseTo(OBSERVED.answers.route.confidence, 12);
  });

  it('throws on a non-2xx rather than handing back a half-answer', async () => {
    const fetchImpl = vi.fn(async () => new Response('no such route', { status: 404 }));
    await expect(askSystemOne({ baseURL: 'http://x', request: REQUEST, fetchImpl })).rejects.toThrow(/404/);
  });

  it('throws when the body carries no answers', async () => {
    await expect(askSystemOne({ baseURL: 'http://x', request: REQUEST, fetchImpl: ok({ model: 'x' }) })).rejects.toThrow(
      /no answers/,
    );
  });
});
