import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';
import { JEV_SYSTEM_ONE, OPENAI_DECISIONS } from '../utils/openinference-decision/protocols';
import { traceDecisions, type DecisionFetch } from '../utils/openinference-decision/trace';
import { askSystemOne, isChoiceAnswer } from '../utils/system-one';
import { OBSERVED, REQUEST } from './fixtures/jev-cpp';

function recorder() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), spans: () => exporter.getFinishedSpans() };
}

const answering = (body: unknown, status = 200) =>
  vi.fn<DecisionFetch>(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

/**
 * The "Select from fixed options" request from the OpenAI Decisions guide
 * (developers.openai.com/api/docs/guides/decisions), verbatim.
 */
const GUIDE_REQUEST = {
  model: 'gpt-6-luna',
  input: 'I was charged twice for my order.',
  questions: [
    {
      type: 'choice',
      name: 'department',
      instructions: 'Which department should handle this complaint?',
      choices: [
        { value: 'billing', description: 'Payments, invoices, and refunds.' },
        { value: 'technical', description: 'Problems using the product.' },
        { value: 'shipping', description: 'Delivery and tracking.' },
        { value: 'other', description: 'Requests outside these categories.' },
      ],
    },
  ],
};

/**
 * A full response body: the guide only shows an `answers` excerpt, so the
 * envelope (`model`, `usage`) is the one simonw/llm-openai-decisions requires
 * and pins in its tests, around the guide's own answer for this request.
 */
const FULL_RESPONSE = {
  model: 'gpt-6-luna',
  answers: [
    {
      type: 'choice',
      name: 'department',
      choice: 'billing',
      probabilities: [
        { value: 'billing', probability: 0.95 },
        { value: 'technical', probability: 0.02 },
        { value: 'shipping', probability: 0.01 },
        { value: 'other', probability: 0.02 },
      ],
      confidence: 0.93,
    },
  ],
  usage: {
    input_tokens: 42,
    output_tokens: 0,
    total_tokens: 42,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

const postDecision = (fetchImpl: DecisionFetch, body: unknown) =>
  fetchImpl('https://api.openai.com/v1/decisions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    body: JSON.stringify(body),
  });

describe('traceDecisions over Jev System One', () => {
  it('records a real jev.cpp exchange as one DECISION span, and leaves the response to the client', async () => {
    const { tracer, spans } = recorder();
    const fetchImpl = traceDecisions({ tracer, protocol: JEV_SYSTEM_ONE, fetchImpl: answering(OBSERVED) });

    const response = await askSystemOne({ baseURL: 'http://localhost:18080', request: REQUEST, fetchImpl });
    const route = response.answers.route;
    expect(isChoiceAnswer(route) && route.choice).toBe('payments');

    expect(spans()).toHaveLength(1);
    const [span] = spans();
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'openinference.span.kind': 'DECISION',
      'decision.system': 'typesafe',
      'decision.request.model_name': 'autojev',
      'decision.response.model_name': 'autojev-qwen3.8-27b',
      'decision.model_name': 'autojev-qwen3.8-27b',
      'decision.token_count.input': 202,
      'decision.token_count.output': 0,
      'input.mime_type': 'application/json',
      'output.mime_type': 'application/json',
      'http.response.status_code': 200,
    });
    expect(JSON.parse(String(span.attributes['input.value']))).toEqual(REQUEST);
    expect(JSON.parse(String(span.attributes['output.value']))).toEqual(OBSERVED);
    // Nothing says who hosts a Jev server, so nothing claims to.
    expect(span.attributes).not.toHaveProperty('decision.provider');
    // A decision model is not a language model (decision_spans.md).
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('llm.'))).toEqual([]);
  });

  it('records a non-2xx as an error with its status and body, and still hands the response back', async () => {
    const { tracer, spans } = recorder();
    const inner = vi.fn<DecisionFetch>(async () => new Response('no such route', { status: 404 }));
    const fetchImpl = traceDecisions({ tracer, protocol: JEV_SYSTEM_ONE, fetchImpl: inner });

    await expect(askSystemOne({ baseURL: 'http://x', request: REQUEST, fetchImpl })).rejects.toThrow(/404.*no such route/);

    const [span] = spans();
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'HTTP 404' });
    expect(span.attributes).toMatchObject({
      'http.response.status_code': 404,
      'output.value': 'no such route',
      'output.mime_type': 'text/plain',
      'decision.model_name': 'autojev',
    });
  });

  it('records a transport failure and rethrows it', async () => {
    const { tracer, spans } = recorder();
    const failure = new TypeError('fetch failed');
    const fetchImpl = traceDecisions({
      tracer,
      protocol: JEV_SYSTEM_ONE,
      fetchImpl: async () => {
        throw failure;
      },
    });

    await expect(askSystemOne({ baseURL: 'http://x', request: REQUEST, fetchImpl })).rejects.toBe(failure);

    const [span] = spans();
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'fetch failed' });
    expect(span.events.map((event) => event.name)).toEqual(['exception']);
    expect(span.attributes).not.toHaveProperty('http.response.status_code');
  });

  it('nests under an explicit parent, since a worker has no active context to find one in', async () => {
    const { tracer, spans } = recorder();
    const parentSpan = tracer.startSpan('gate');
    const parent = trace.setSpan(ROOT_CONTEXT, parentSpan);
    const fetchImpl = traceDecisions({ tracer, protocol: JEV_SYSTEM_ONE, fetchImpl: answering(OBSERVED), parent });

    await askSystemOne({ baseURL: 'http://x', request: REQUEST, fetchImpl });
    parentSpan.end();

    const decision = spans().find((span) => span.name === JEV_SYSTEM_ONE.spanName);
    expect(decision?.spanContext().traceId).toBe(parentSpan.spanContext().traceId);
    expect(decision?.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
  });
});

describe('traceDecisions over OpenAI Decisions', () => {
  it('maps the documented request and full response onto the same span', async () => {
    const { tracer, spans } = recorder();
    const fetchImpl = traceDecisions({ tracer, protocol: OPENAI_DECISIONS, fetchImpl: answering(FULL_RESPONSE) });

    const response = await postDecision(fetchImpl, GUIDE_REQUEST);
    expect(await response.json()).toEqual(FULL_RESPONSE);

    const [span] = spans();
    expect(span.attributes).toMatchObject({
      'openinference.span.kind': 'DECISION',
      'decision.system': 'openai',
      'decision.provider': 'openai',
      'decision.request.model_name': 'gpt-6-luna',
      'decision.response.model_name': 'gpt-6-luna',
      'decision.model_name': 'gpt-6-luna',
      'decision.token_count.input': 42,
      'decision.token_count.output': 0,
    });
    expect(JSON.parse(String(span.attributes['input.value']))).toEqual(GUIDE_REQUEST);
    // No total, no cache split: the spec derives a total, and has no detail attributes.
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('decision.token_count.'))).toEqual([
      'decision.token_count.input',
      'decision.token_count.output',
    ]);
  });

  it('sets no counts and no response model that the server did not report', async () => {
    const { tracer, spans } = recorder();
    // The guide's own response excerpt: answers only.
    const excerpt = { answers: FULL_RESPONSE.answers };
    const fetchImpl = traceDecisions({ tracer, protocol: OPENAI_DECISIONS, fetchImpl: answering(excerpt) });

    await postDecision(fetchImpl, GUIDE_REQUEST);

    const [span] = spans();
    expect(span.attributes['decision.model_name']).toBe('gpt-6-luna');
    expect(span.attributes).not.toHaveProperty('decision.response.model_name');
    expect(span.attributes).not.toHaveProperty('decision.token_count.input');
    expect(span.attributes).not.toHaveProperty('decision.token_count.output');
  });

  it('passes calls to other endpoints through untraced', async () => {
    const { tracer, spans } = recorder();
    const inner = answering({ data: [] });
    const fetchImpl = traceDecisions({ tracer, protocol: OPENAI_DECISIONS, fetchImpl: inner });

    await fetchImpl('https://api.openai.com/v1/models', { method: 'GET' });
    await fetchImpl('https://api.openai.com/v1/decisions?beta=1', { method: 'POST', body: '{}' });

    expect(inner).toHaveBeenCalledTimes(2);
    expect(spans()).toHaveLength(1);
  });
});
