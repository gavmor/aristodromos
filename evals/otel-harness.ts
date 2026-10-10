// OTel wiring for the eval: one TracerProvider, two sinks.
//
// The spike's claim is that Arize Phoenix and Pydantic Logfire are not two
// harnesses, they are two BACKENDS for one instrumentation. So this file sets
// up the substrate once:
//
//   InMemorySpanExporter  — the grader's input. Hermetic: no collector, no
//                           container, no network. This is what runs in CI.
//   OTLP -> Phoenix       — opt-in, keyed on PHOENIX_COLLECTOR_ENDPOINT, for
//                           when a human wants to LOOK at the trace.
//
// That split is the finding in miniature: the scoring needs no platform, and
// the platform is what costs you a `docker run`. Every eval below works with
// the env var unset.
import { trace, type Tracer } from '@opentelemetry/api';
import { SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions';
import { configureLogfireApi } from '@pydantic/logfire-api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/** Set this to a running Phoenix (default `http://localhost:6006`) to also ship the trace. */
export const PHOENIX_ENDPOINT_ENV = 'PHOENIX_COLLECTOR_ENDPOINT';

/** The instrumentation scope the mock agent loop traces under. */
export const EVAL_SCOPE = 'aristodromos.eval';

/** The scope `@pydantic/logfire-api` writes under. */
export const LOGFIRE_SCOPE = 'logfire';

export interface TraceHarness {
  /** the tracer the instrumented loop writes to */
  tracer: Tracer;
  /** every span that has ENDED — the grader reads these, not live spans */
  finishedSpans(): ReadableSpan[];
  /** true when spans are also being shipped to a live Phoenix */
  live: boolean;
  reset(): void;
  shutdown(): Promise<void>;
}

/**
 * The live sink, loaded only if asked for. The import is dynamic on purpose:
 * `@opentelemetry/exporter-trace-otlp-proto` drags in a protobuf runtime, and a
 * CI gate should not pay for a dependency it never calls.
 */
async function phoenixProcessor(endpoint: string | undefined): Promise<SpanProcessor | null> {
  if (!endpoint) return null;
  const [{ OTLPTraceExporter }, { BatchSpanProcessor }] = await Promise.all([
    import('@opentelemetry/exporter-trace-otlp-proto'),
    import('@opentelemetry/sdk-trace-base'),
  ]);
  return new BatchSpanProcessor(
    new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` }),
  );
}

/**
 * Register a provider globally and hand back the handles the eval needs.
 *
 * Registration is GLOBAL because `@pydantic/logfire-api` resolves its tracer
 * from the global API at import time — it has no `configure({ tracer })` door.
 * That is a real constraint on how a Logfire-instrumented eval can be
 * sandboxed, and it is why `shutdown()` calls `trace.disable()`.
 */
export async function createTraceHarness(
  projectName = 'aristodromos-steerability',
  env: Record<string, string | undefined> = process.env,
): Promise<TraceHarness> {
  const memory = new InMemorySpanExporter();
  const spanProcessors: SpanProcessor[] = [new SimpleSpanProcessor(memory)];

  const live = await phoenixProcessor(env[PHOENIX_ENDPOINT_ENV]);
  if (live) spanProcessors.push(live);

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'aristodromos',
      // Phoenix reads this resource attribute to file the trace under a project.
      [SEMRESATTRS_PROJECT_NAME]: projectName,
    }),
    spanProcessors,
  });

  trace.disable();
  trace.setGlobalTracerProvider(provider);

  // MEASURED GOTCHA, not boilerplate. `@pydantic/logfire-api` resolves
  // `trace.getTracer('logfire')` at MODULE IMPORT — which, in a test file, is
  // before any provider exists — and that stale handle never heals. Without
  // this re-bind every `logfire.span()` call below succeeds, prints nothing,
  // and records NOTHING. A Logfire-instrumented eval can therefore go green
  // while measuring zero spans; see the "missing decision span" guard in
  // span-grader.ts for the same hazard from the other end.
  configureLogfireApi({ otelScope: LOGFIRE_SCOPE });

  return {
    tracer: provider.getTracer(EVAL_SCOPE),
    finishedSpans: () => memory.getFinishedSpans(),
    live: live !== null,
    reset: () => memory.reset(),
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
    },
  };
}
