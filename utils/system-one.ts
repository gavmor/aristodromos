// A typed wrapper over `POST /v1/systemone` — the Jev "System One" protocol.
//
// The protocol is a classifier call, not a chat call: you send a `state` and a
// map of `questions`, and every answer is read from LABEL-TOKEN PROBABILITIES.
// Nothing is parsed out of generated text, so there is no "the model replied in
// prose instead" failure mode and no retry loop. One request, one forward pass,
// calibrated numbers out.
//
// The three question types:
//   noul   — a yes/no, answered as P(yes).
//   choice — named criteria {name: description}, answered as the winning name
//            plus the full distribution and a confidence.
//   score  — ordered criteria [l0, l1, ...], answered as a scalar on that scale.
//
// We only use `choice` and `noul` here; `score` is typed because it is part of
// the protocol and a consumer should not have to widen the union to read one.
//
// Deliberately provider-agnostic: `baseURL` points at ANY compatible server
// (AutoJev, WebJev, Jeff, Laya, ...). There is nothing AutoJev-specific below.

/** One question in the request. The server rejects anything off this shape with a 400. */
export type SystemOneQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface SystemOneRequest {
  model: string;
  /** everything the classifier is allowed to condition on, as one text blob */
  state: string;
  /** keyed by question name; the same names come back in `answers` */
  questions: Record<string, SystemOneQuestion>;
}

/**
 * `confidence` is the SERVER's number and is read, never recomputed. Observed
 * against jev.cpp it is the scaled max probability, (p_max - 1/K) / (1 - 1/K) —
 * NOT the normalized-entropy form `1 - H(p)/ln K` the protocol note quotes.
 * (Checked against a real response: p_max 0.9754878 over K=3 gives exactly the
 * reported 0.96323171, where the entropy form would give 0.880.) Since different
 * Jev providers may calibrate differently, treating it as an opaque server
 * output is also the portable choice.
 */
export type SystemOneAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number; legend?: string[] };

/**
 * The protocol's ceiling on a single choice question: 1–255 option descriptions
 * (jev.cpp tools/server/README.md). It matters here because it is a hard limit
 * on how many legal actions one question can NAME — see system-one-brain.ts.
 */
export const MAX_CHOICE_CRITERIA = 255;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export const isChoiceAnswer = (a: SystemOneAnswer | undefined): a is Extract<SystemOneAnswer, { type: 'choice' }> =>
  a?.type === 'choice';

export const isNoulAnswer = (a: SystemOneAnswer | undefined): a is Extract<SystemOneAnswer, { type: 'noul' }> =>
  a?.type === 'noul';

/** Injectable so tests can drive the client without a network or a 16 GiB model. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SystemOneClientOptions {
  /** server root, e.g. `http://localhost:18080`; `/v1/systemone` is appended */
  baseURL: string;
  fetchImpl?: FetchLike;
}

/**
 * One round trip. Throws on a non-2xx rather than returning a half-answer — a
 * caller that cannot tell "the classifier is unsure" from "the server is down"
 * would gate on garbage.
 */
export async function askSystemOne(
  options: SystemOneClientOptions & { request: SystemOneRequest; signal?: AbortSignal },
): Promise<SystemOneResponse> {
  const { baseURL, request, signal } = options;
  const doFetch = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const url = `${baseURL.replace(/\/+$/, '')}/v1/systemone`;

  const response = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`system-one ${response.status} from ${url}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const body = (await response.json()) as SystemOneResponse;
  if (!body || typeof body !== 'object' || !body.answers) {
    throw new Error(`system-one returned no answers from ${url}`);
  }
  return body;
}
