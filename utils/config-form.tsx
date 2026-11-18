// The goal/brain/System One/tracing form, shared by the DevTools panel and the
// toolbar popup. It renders from `browser.storage.local` and re-renders on every
// change there, so no field can show anything but the stored config. It knows
// nothing of DevTools or of any tab: whoever renders it decides what saving means
// beyond storing the config.
import { useState } from 'preact/hooks';
import { ModelPicker } from '../components/model-picker';
import {
  type AgentConfig,
  CONFIG_KEY,
  type Provider,
  resolveConfig,
  SUGGESTED_SYSTEM_ONE,
  SUGGESTED_TRACING,
} from './agent-config';
import { type Stored, useStorage } from './use-storage';

export interface ConfigFormProps {
  /** the submit button's label */
  submitLabel: string;
  /** show the brain settings expanded */
  brainOpen?: boolean;
  /** run after the config is stored; its failure is shown beside the button */
  afterSave?: (config: AgentConfig) => Promise<void>;
}

/** The fields as typed: what is shown until the next save or the next change in storage. */
interface Draft {
  goal: string;
  provider: Provider;
  model: string;
  baseURL: string;
  apiKey: string;
  soEnabled: boolean;
  soBaseURL: string;
  soModel: string;
  soThreshold: string;
  trEnabled: boolean;
  trEndpoint: string;
  trProject: string;
}

function draftOf(config: AgentConfig): Draft {
  const systemOne = config.systemOne ?? SUGGESTED_SYSTEM_ONE;
  const tracing = config.tracing ?? SUGGESTED_TRACING;
  return {
    goal: config.goal,
    provider: config.provider,
    model: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey ?? '',
    soEnabled: config.systemOne !== undefined,
    soBaseURL: systemOne.baseURL,
    soModel: systemOne.model,
    soThreshold: String(systemOne.threshold),
    trEnabled: config.tracing !== undefined,
    trEndpoint: tracing.endpoint,
    trProject: tracing.project,
  };
}

function configOf(draft: Draft): AgentConfig {
  const config: AgentConfig = {
    goal: draft.goal.trim(),
    provider: draft.provider,
    model: draft.model.trim(),
    baseURL: draft.baseURL.trim(),
  };
  if (draft.apiKey.trim()) config.apiKey = draft.apiKey.trim();
  if (draft.soEnabled) {
    config.systemOne = {
      baseURL: draft.soBaseURL.trim(),
      model: draft.soModel.trim(),
      threshold: Number(draft.soThreshold),
    };
  }
  if (draft.trEnabled) config.tracing = { endpoint: draft.trEndpoint.trim(), project: draft.trProject.trim() };
  return config;
}

type TextKey = { [K in keyof Draft]: Draft[K] extends string ? K : never }[keyof Draft];
type FlagKey = Exclude<keyof Draft, TextKey>;

export function ConfigForm({ submitLabel, brainOpen = false, afterSave }: ConfigFormProps) {
  const stored = useStorage('local', CONFIG_KEY);
  const [note, setNote] = useState('');
  // Storage is the record: every change to it is what the form shows. Typing
  // makes a draft of the reading it started from; the next change discards it.
  const [edited, setEdited] = useState<{ from: Stored; draft: Draft } | undefined>();
  const draftFrom = (current: typeof edited): Draft =>
    current?.from === stored ? current.draft : draftOf(resolveConfig(stored.value));
  const draft = draftFrom(edited);

  const edit = (patch: Partial<Draft>): void => {
    setEdited((current) => ({ from: stored, draft: { ...draftFrom(current), ...patch } }));
    setNote('unsaved');
  };
  const text = (key: TextKey) => ({
    value: draft[key],
    onInput: (event: Event) => edit({ [key]: (event.currentTarget as HTMLInputElement).value }),
  });
  const flag = (key: FlagKey) => ({
    type: 'checkbox' as const,
    checked: draft[key],
    onChange: (event: Event) => edit({ [key]: (event.currentTarget as HTMLInputElement).checked }),
  });

  const submit = (event: Event): void => {
    event.preventDefault();
    const config = configOf(draft);
    void browser.storage.local
      .set({ [CONFIG_KEY]: config })
      .then(() => afterSave?.(config))
      .then(
        () => setNote(`saved ${new Date().toLocaleTimeString()}`),
        (error: unknown) => setNote(`failed: ${String(error)}`),
      );
  };

  // A disabled fieldset skips validation and is left out of the saved config.
  return (
    <form id="config" onSubmit={submit}>
      <label>
        Goal <small>(empty = idle)</small>
        <textarea id="goal" rows={3} {...text('goal')} />
      </label>
      <details id="brain" open={brainOpen}>
        <summary>Brain</summary>
        <div class="row">
          <label htmlFor="model-picker">
            Provider and model{' '}
            <ModelPicker
              provider={draft.provider}
              model={draft.model}
              baseURL={draft.baseURL}
              apiKey={draft.apiKey}
              onPick={(provider, model, baseURL) => edit({ provider, model, baseURL })}
            />
          </label>
        </div>
        <div class="row">
          <label>
            Model <input id="model" required {...text('model')} />
          </label>
          <label>
            Base URL <input id="base-url" type="url" required {...text('baseURL')} />
          </label>
          <label>
            API key <small>(Gemini)</small>{' '}
            <input id="api-key" type="password" autoComplete="off" {...text('apiKey')} />
          </label>
        </div>
        <fieldset id="so-fields" disabled={!draft.soEnabled}>
          <legend>
            <label class="inline">
              <input id="so-enabled" {...flag('soEnabled')} /> System One in front
            </label>
          </legend>
          <div class="row">
            <label>
              Base URL <input id="so-base-url" type="url" required {...text('soBaseURL')} />
            </label>
            <label>
              Model <input id="so-model" required {...text('soModel')} />
            </label>
            <label>
              Threshold{' '}
              <input id="so-threshold" type="number" min="0" max="1" step="0.05" required {...text('soThreshold')} />
            </label>
          </div>
        </fieldset>
        <fieldset id="tr-fields" disabled={!draft.trEnabled}>
          <legend>
            <label class="inline">
              <input id="tr-enabled" {...flag('trEnabled')} /> Trace each decision (OTLP, e.g. Phoenix)
            </label>
          </legend>
          <div class="row">
            <label>
              Traces endpoint <input id="tr-endpoint" type="url" required {...text('trEndpoint')} />
            </label>
            <label>
              Project <input id="tr-project" required {...text('trProject')} />
            </label>
          </div>
        </fieldset>
      </details>
      <div class="actions">
        <button id="submit-config" type="submit">
          {submitLabel}
        </button>
        <span id="save-note" class="muted">
          {note}
        </span>
      </div>
    </form>
  );
}
