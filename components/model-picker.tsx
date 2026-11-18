/** @jsxImportSource react */
// The provider + model picker: assistant-ui's ModelSelector in standalone mode,
// run through preact/compat. It holds no config of its own: the form passes the
// draft's provider/model/baseURL in and gets a pick back. Its props are
// primitives only, so React's and Preact's JSX types never meet at this boundary.
//
// Each provider's models are listed live whenever the picker opens. The provider
// in use is asked at the configured base URL; the others at their usual one
// (SUGGESTED_BASE_URLS). A provider that does not answer is a group whose
// heading says why, and nothing in it can be picked.
import { useState } from 'react';
import {
  type ModelOption,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorRoot,
  ModelSelectorTrigger,
} from '@/components/assistant-ui/elements/model-selector';
import { PROVIDER_LABELS, PROVIDERS, type Provider, SUGGESTED_BASE_URLS } from '@/utils/agent-config';
import { listModels } from '@/utils/model-catalog';

export interface ModelPickerProps {
  provider: Provider;
  model: string;
  baseURL: string;
  apiKey: string;
  onPick: (provider: Provider, model: string, baseURL: string) => void;
}

/** One provider's answer: listing, listed, or why not. */
type Listing = { state: 'listing' } | { state: 'listed'; models: string[] } | { state: 'failed'; why: string };

const SEPARATOR = ':';

export function ModelPicker({ provider, model, baseURL, apiKey, onPick }: ModelPickerProps) {
  const [listings, setListings] = useState<Partial<Record<Provider, Listing>>>({});
  const urlOf = (candidate: Provider) => (candidate === provider ? baseURL : SUGGESTED_BASE_URLS[candidate]);

  const listAll = (): void => {
    for (const candidate of PROVIDERS) {
      const set = (listing: Listing) => setListings((current) => ({ ...current, [candidate]: listing }));
      if (candidate === 'gemini' && !apiKey) {
        set({ state: 'failed', why: 'no API key set' });
        continue;
      }
      set({ state: 'listing' });
      listModels(candidate, urlOf(candidate), apiKey).then(
        (models) => set({ state: 'listed', models }),
        (error: unknown) => set({ state: 'failed', why: error instanceof Error ? error.message : String(error) }),
      );
    }
  };

  const groups = PROVIDERS.map((candidate) => {
    const listing = listings[candidate];
    const url = urlOf(candidate);
    const known = candidate === provider && model ? [model] : [];
    const option = (id: string, disabled: boolean, description?: string): ModelOption => ({
      id: `${candidate}${SEPARATOR}${id}`,
      name: id || 'no models listed',
      disabled,
      description,
    });
    let heading = `${PROVIDER_LABELS[candidate]} · ${url}`;
    let options: ModelOption[];
    if (listing?.state === 'listed') {
      options = listing.models.map((id) => option(id, false));
      for (const id of known) if (!listing.models.includes(id)) options.push(option(id, true, 'not on this server'));
    } else if (listing?.state === 'failed') {
      heading = `${PROVIDER_LABELS[candidate]} · no answer from ${url} (${listing.why})`;
      options = (known.length > 0 ? known : ['']).map((id) => option(id, true));
    } else {
      // Not listed yet: the model in use stays shown, and pickable as it is now.
      options = known.map((id) => option(id, false));
    }
    return { candidate, heading, options, url };
  });

  return (
    <ModelSelectorRoot
      models={groups.flatMap((group) => group.options)}
      value={`${provider}${SEPARATOR}${model}`}
      onOpenChange={(open) => {
        if (open) listAll();
      }}
      onValueChange={(id) => {
        const at = id.indexOf(SEPARATOR);
        const picked = id.slice(0, at) as Provider;
        const group = groups.find((candidate) => candidate.candidate === picked);
        if (group) onPick(picked, id.slice(at + 1), group.url);
      }}
    >
      <ModelSelectorTrigger id="model-picker" type="button" data-provider={provider} />
      <ModelSelectorContent searchable={false}>
        <ModelSelectorList>
          {groups.map((group) => (
            <ModelSelectorGroup key={group.candidate} heading={group.heading}>
              {group.options.map((option) => (
                <ModelSelectorItem key={option.id} model={option} />
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}
