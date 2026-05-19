import type { Operation } from 'fast-json-patch';
import type { OperationSchema } from './types';

export interface AgentDecision {
  operations: Operation[];
  reasoning: string;
}

export interface AgentStrategy {
  readonly name: string;
  decide(
    schema: OperationSchema,
    newInformation: string[],
    abortSignal: AbortSignal,
  ): Promise<AgentDecision>;
}
