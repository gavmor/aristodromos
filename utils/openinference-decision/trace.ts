// Forked from Arize-ai/openinference
// js/packages/openinference-instrumentation-typesafe/src/instrumentation.ts
// (commit c364180e5be52f0cdc00fbc88f9462603569f4e2), Apache-2.0.
// Modified: the @typesafe-ai/sdk binding is replaced by an explicit fetch
// wrapper, so it runs in an MV3 service worker. See LICENSE and NOTICE here.
//
// Upstream patches `TypeSafeClient.prototype.systemOne` through a require hook
// and reads the SDK's APIPromise. None of that exists here: a worker has no
// require hook, a bundled ESM module cannot be patched, and the clients in this
// repo are plain `fetch` calls. What every decision client does have is the
// request it sends and the response it gets back, so that is the seam: wrap
// the fetch a client is given, and each call to the protocol's endpoint becomes
// one DECISION span, with the bodies on the wire as its input and output.
//
// The tracer is passed in, never the global one. So is the parent context: a
// worker has no context manager, so `context.active()` is the root context
// there, and a decision is a trace of its own unless the caller says otherwise.
import { context, diag, SpanKind, SpanStatusCode, type Context, type Span, type Tracer } from '@opentelemetry/api';
import { getDecisionAttributes, withSafety } from '@arizeai/openinference-core';
import { OpenInferenceSpanKind, SemanticConventions } from '@arizeai/openinference-semantic-conventions';
import { ATTR_HTTP_RESPONSE_STATUS_CODE } from '@opentelemetry/semantic-conventions';
import { getRequestAttributes, getResponseAttributes } from './attributes';

/** The fetch a decision client is given, and the one it gets back. */
export type DecisionFetch = (input: string, init: RequestInit) => Promise<Response>;

/** What makes one decision API different from another, as far as a span cares. */
export interface DecisionProtocol {
  spanName: string;
  /** `decision.system`: the request/response shape the client speaks */
  system: string;
  /** `decision.provider`: who hosts the model, when that is known */
  provider?: string;
  /** the endpoint's path; a request to any other path passes through untraced */
  path: string;
}

export interface TraceDecisionsOptions {
  tracer: Tracer;
  protocol: DecisionProtocol;
  /** the fetch to wrap; the global one by default */
  fetchImpl?: DecisionFetch;
  /** parent of every span; `context.active()` by default, the root in a worker */
  parent?: Context;
}

/**
 * Invokes a span-recording callback, logging and swallowing telemetry errors so
 * they never surface to the traced caller.
 */
const safelyRecord = withSafety({
  fn: (record: () => void) => {
    record();
  },
  onError: (error) => {
    diag.warn('decision tracing could not record telemetry', error);
  },
});

function endWithError(span: Span, error: unknown): void {
  safelyRecord(() => {
    span.recordException(error instanceof Error ? error : String(error));
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
    span.end();
  });
}

/**
 * `fetchImpl`, with every call to `protocol.path` recorded as an OpenInference
 * DECISION span. The caller gets the server's response untouched: the span reads
 * a clone, and ends before the response is handed back. A transport failure is
 * recorded on the span and rethrown; a non-2xx is recorded as an error with its
 * status and body, and returned for the client to handle as it always does.
 */
export function traceDecisions({
  tracer,
  protocol,
  fetchImpl = (input, init) => fetch(input, init),
  parent,
}: TraceDecisionsOptions): DecisionFetch {
  return async (input, init) => {
    const [path = ''] = input.split(/[?#]/, 1);
    if (!path.endsWith(protocol.path)) return fetchImpl(input, init);

    const span = tracer.startSpan(
      protocol.spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.DECISION,
          ...getDecisionAttributes({ system: protocol.system, provider: protocol.provider }),
        },
      },
      parent ?? context.active(),
    );
    const { body } = init;
    if (typeof body === 'string') safelyRecord(() => span.setAttributes(getRequestAttributes(body)));

    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      endWithError(span, error);
      throw error;
    }

    try {
      const text = await response.clone().text();
      safelyRecord(() => {
        span.setAttributes({ [ATTR_HTTP_RESPONSE_STATUS_CODE]: response.status, ...getResponseAttributes(text) });
        span.setStatus(response.ok ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
        span.end();
      });
    } catch (error) {
      // The body failed mid-read (an abort, a dropped connection); the client
      // will meet the same failure on its own copy.
      endWithError(span, error);
    }
    return response;
  };
}
