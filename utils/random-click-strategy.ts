import type { Operation } from 'fast-json-patch';
import type { AgentStrategy, AgentDecision } from './strategy';
import type { OperationSchema } from './types';

/**
 * Strategy that picks a random clickable element from the page schema.
 * Useful for testing the agent loop without an LLM running.
 */
export class RandomClickStrategy implements AgentStrategy {
  readonly name = 'random-click';

  async decide(
    schema: OperationSchema,
    _newInformation: string[],
    abortSignal: AbortSignal,
  ): Promise<AgentDecision> {
    if (abortSignal.aborted) {
      return { operations: [], reasoning: 'Aborted before decision.' };
    }

    const clickablePaths = schema.allowedPaths.filter((p) => p.endsWith('/clicked'));

    if (clickablePaths.length === 0) {
      return {
        operations: [],
        reasoning: 'No clickable elements found on the page.',
      };
    }

    const selectedPath = clickablePaths[Math.floor(Math.random() * clickablePaths.length)];

    return {
      operations: [{ op: 'replace', path: selectedPath, value: true }] as Operation[],
      reasoning: `Randomly selected ${selectedPath} to click.`,
    };
  }
}
