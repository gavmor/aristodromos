// Forked from Arize-ai/openinference
// js/packages/openinference-instrumentation-typesafe/src/attributes.ts
// (commit c364180e5be52f0cdc00fbc88f9462603569f4e2), Apache-2.0.
// Modified: reads the bodies on the wire rather than @typesafe-ai/sdk objects,
// and drops the SDK's invocation parameters. See LICENSE and NOTICE here.
//
// Every decision API this repo speaks names the model `model` and the usage
// `usage.input_tokens` / `usage.output_tokens`, in the request and the response
// alike (Jev System One, OpenAI Decisions, and the TypeSafe API upstream was
// written for). So these readers are shared, and the protocol only decides
// which system and provider the span is attributed to.
import type { Attributes } from '@opentelemetry/api';
import {
  getDecisionAttributes,
  getInputAttributes,
  getOutputAttributes,
  isObjectWithStringKeys,
  safelyJSONParse,
} from '@arizeai/openinference-core';
import { MimeType } from '@arizeai/openinference-semantic-conventions';

/** A body as sent or received, and its parsed JSON object when it is one. */
function readBody(body: string): { value: string; mimeType: MimeType; json?: Record<string, unknown> } {
  const json = safelyJSONParse(body);
  // An error page or a plain-text 404 is still worth keeping, as text.
  if (!isObjectWithStringKeys(json)) return { value: body, mimeType: MimeType.TEXT };
  return { value: body, mimeType: MimeType.JSON, json };
}

/**
 * Builds OpenInference attributes for a decision request body: the body itself
 * on `input.value`, and the model it asks for as `decision.request.model_name`.
 */
function getRequestAttributes(body: string): Attributes {
  const { json, ...input } = readBody(body);
  const model = json?.model;
  return {
    ...getInputAttributes(input),
    ...getDecisionAttributes({ requestModelName: typeof model === 'string' ? model : undefined }),
  };
}

/**
 * Builds OpenInference attributes for a decision response body: the body on
 * `output.value`, and, when the server reports them, the model that answered
 * as `decision.response.model_name` and the usage as `decision.token_count.*`.
 * A count the server did not report is not set.
 */
function getResponseAttributes(body: string): Attributes {
  const { json, ...output } = readBody(body);
  if (!json) return getOutputAttributes(output);

  const { model, usage } = json;
  const tokens: Record<string, unknown> = isObjectWithStringKeys(usage) ? usage : {};
  const { input_tokens: inputTokens, output_tokens: outputTokens } = tokens;

  return {
    ...getOutputAttributes(output),
    ...getDecisionAttributes({
      responseModelName: typeof model === 'string' ? model : undefined,
      tokenCount: {
        input: typeof inputTokens === 'number' ? inputTokens : undefined,
        output: typeof outputTokens === 'number' ? outputTokens : undefined,
      },
    }),
  };
}

export { getRequestAttributes, getResponseAttributes };
