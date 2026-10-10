// Promptfoo custom provider: a mock brain dressed as an LLM endpoint.
//
// Promptfoo's unit of work is "a provider turns a prompt into an output string".
// Our unit of work is "a policy turns a Scene + goal into one trigger id". This
// file is the whole adapter between those two, and its size is the honest cost
// of using promptfoo for a non-text decision: ~40 lines, no network, no keys.
//
// Note what the prompt is NOT doing. The brain reads the Scene from the fixture,
// not from the rendered prompt string, because the real decision edge takes a
// typed Scene. The prompt is reduced to a human-readable label for the results
// table. If we ever grade the REAL brain here, this is the seam where the Scene
// gets serialised into the model's observation instead.
import type { ApiProvider, CallApiContextParams, ProviderResponse } from 'promptfoo';
import { DEFAULT_SEED, makeBrain, type BrainName } from '../brains';
import { caseById, offeredActionIds } from '../steerability';

interface BrainProviderOptions {
  id?: string;
  label?: string;
  config?: { brain?: BrainName; seed?: number };
}

export default class BrainProvider implements ApiProvider {
  private readonly providerId: string;
  private readonly brain: ReturnType<typeof makeBrain>;

  constructor(options: BrainProviderOptions = {}) {
    const name: BrainName = options.config?.brain ?? 'deterministic';
    this.providerId = options.id ?? `brain:${name}`;
    this.brain = makeBrain(name, options.config?.seed ?? DEFAULT_SEED);
  }

  id(): string {
    return this.providerId;
  }

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const caseId = String(context?.vars?.caseId ?? '');
    const fixture = caseById(caseId);
    const choice = this.brain(fixture, fixture.goal);

    return {
      output: JSON.stringify(choice),
      format: 'json',
      metadata: {
        caseId,
        offered: offeredActionIds(fixture.scene),
      },
    };
  }
}
