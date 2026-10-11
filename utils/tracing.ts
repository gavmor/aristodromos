// Tracing: every brain call as an OpenInference trace, for Phoenix.
//
// The AI SDK emits OpenTelemetry spans through `@ai-sdk/otel`;
// `@arizeai/openinference-vercel` enriches them with OpenInference attributes
// (span kind, input/output messages, the schema, token counts) so Phoenix shows
// each decision as an LLM call: the outline the model saw, and what it chose.
//
// Nothing is registered globally. The integration is handed to each
// `generateObject` call, which takes precedence over any global one, so tracing
// follows the stored config the way the brain does: switched on, off, or
// pointed elsewhere without restarting the worker.
//
// Two constraints of an MV3 service worker shape this:
// - There is no AsyncLocalStorage, so no context manager. That is fine: the AI
//   SDK threads each child span's parent explicitly, per call; a decision is a
//   trace of its own.
// - The worker can be evicted at any idle moment, so spans are exported as they
//   end (a simple processor), not held for a batch that might never flush. The
//   browser build of the OTLP exporter sends with `fetch`, which a worker has.
import { OpenTelemetry } from '@ai-sdk/otel';
import { SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions';
import { enrichSpanWithOpenInference, OpenInferenceSimpleSpanProcessor } from '@arizeai/openinference-vercel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { Telemetry } from 'ai';
import type { TracingSettings } from './agent-config';

interface Tracing {
  key: string;
  provider: BasicTracerProvider;
  telemetry: Telemetry;
}

let current: Tracing | undefined;

/**
 * The telemetry integration for these settings, or undefined when tracing is
 * off. One provider per endpoint and project, reused across decisions; a change
 * of either flushes and shuts down the old one.
 */
export function telemetryFor(settings: TracingSettings | undefined): Telemetry | undefined {
  const key = settings ? `${settings.endpoint}\n${settings.project}` : undefined;
  if (current && current.key !== key) {
    void current.provider.shutdown();
    current = undefined;
  }
  if (!settings || key === undefined) return undefined;
  if (current) return current.telemetry;

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [SEMRESATTRS_PROJECT_NAME]: settings.project }),
    spanProcessors: [
      new OpenInferenceSimpleSpanProcessor({ exporter: new OTLPTraceExporter({ url: settings.endpoint }) }),
    ],
  });
  const telemetry = new OpenTelemetry({
    tracer: provider.getTracer('aristodromos'),
    enrichSpan: enrichSpanWithOpenInference,
    usage: true,
    schema: true,
  });
  current = { key, provider, telemetry };
  return telemetry;
}
