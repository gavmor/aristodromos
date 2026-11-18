// The goal/brain/System One/tracing form, shared by the DevTools panel and the
// toolbar popup. It renders from `browser.storage.local` and re-renders on every
// change there, so no field can show anything but the stored config. Its one
// button is the agent's toggle: Start stores the config and starts, Stop stops.
// What starting and stopping mean (which tab) is up to whoever renders it.
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
import { field, inline, labelled, primaryButton } from './ui';
import { type Stored, useStorage } from './use-storage';

const row = 'flex gap-2';
const optional = 'group mt-2 min-w-0 rounded-md border border-border px-2 pt-1 pb-2';
const optionalRow = `${row} group-disabled:opacity-50`;

export interface ConfigFormProps {
  /** show the brain settings expanded */
  brainOpen?: boolean;
  /** the agent is running, so the button stops it */
  running: boolean;
  /** run after the config is stored; its failure is shown beside the button */
  onStart: (config: AgentConfig) => Promise<void>;
  onStop: () => Promise<void>;
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

export function ConfigForm({ brainOpen = false, running, onStart, onStop }: ConfigFormProps) {
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
    setNote(running ? 'unsaved: Stop, then Start, to apply' : 'unsaved');
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

  const settle = (work: Promise<void>, done: string): void => {
    void work.then(
      () => setNote(done),
      (error: unknown) => setNote(`failed: ${String(error)}`),
    );
  };
  const submit = (event: Event): void => {
    event.preventDefault();
    const config = configOf(draft);
    settle(
      browser.storage.local.set({ [CONFIG_KEY]: config }).then(() => onStart(config)),
      `started ${new Date().toLocaleTimeString()}`,
    );
  };

  // A disabled fieldset skips validation and is left out of the saved config.
  return (
    <form id="config" onSubmit={submit}>
      <label class={labelled}>
        <span>
          Goal <small class="text-muted-foreground">(empty = idle)</small>
        </span>
        <textarea id="goal" rows={3} class={`${field} resize-y`} {...text('goal')} />
      </label>
      <details id="brain" open={brainOpen}>
        <summary class="mt-2 cursor-pointer text-muted-foreground">Brain</summary>
        <div class={row}>
          <label class={labelled} htmlFor="model-picker">
            Provider and model
            <ModelPicker
              provider={draft.provider}
              model={draft.model}
              baseURL={draft.baseURL}
              apiKey={draft.apiKey}
              onPick={(provider, model, baseURL) => edit({ provider, model, baseURL })}
            />
          </label>
        </div>
        <div class={row}>
          <label class={labelled}>
            Model <input id="model" required class={field} {...text('model')} />
          </label>
          <label class={labelled}>
            Base URL <input id="base-url" type="url" required class={field} {...text('baseURL')} />
          </label>
          <label class={labelled}>
            <span>
              API key <small class="text-muted-foreground">(Gemini)</small>
            </span>
            <input id="api-key" type="password" autoComplete="off" class={field} {...text('apiKey')} />
          </label>
        </div>
        <fieldset id="so-fields" class={optional} disabled={!draft.soEnabled}>
          <legend class="px-1">
            <label class={inline}>
              <input id="so-enabled" {...flag('soEnabled')} /> System One in front
            </label>
          </legend>
          <div class={optionalRow}>
            <label class={labelled}>
              Base URL <input id="so-base-url" type="url" required class={field} {...text('soBaseURL')} />
            </label>
            <label class={labelled}>
              Model <input id="so-model" required class={field} {...text('soModel')} />
            </label>
            <label class={labelled}>
              Threshold
              <input
                id="so-threshold"
                type="number"
                min="0"
                max="1"
                step="0.05"
                required
                class={field}
                {...text('soThreshold')}
              />
            </label>
          </div>
        </fieldset>
        <fieldset id="tr-fields" class={optional} disabled={!draft.trEnabled}>
          <legend class="px-1">
            <label class={inline}>
              <input id="tr-enabled" {...flag('trEnabled')} /> Trace each decision (OTLP, e.g. Phoenix)
            </label>
          </legend>
          <div class={optionalRow}>
            <label class={labelled}>
              Traces endpoint <input id="tr-endpoint" type="url" required class={field} {...text('trEndpoint')} />
            </label>
            <label class={labelled}>
              Project <input id="tr-project" required class={field} {...text('trProject')} />
            </label>
          </div>
        </fieldset>
      </details>
      <div class="mt-2 flex items-center gap-2">
        {/* Keyed: one click must not land on a button that has just changed what it does. */}
        {running ? (
          <button
            key="stop"
            id="submit-config"
            type="button"
            class={primaryButton}
            onClick={() => settle(onStop(), 'stopped')}
          >
            Stop
          </button>
        ) : (
          <button key="start" id="submit-config" type="submit" class={primaryButton}>
            Start
          </button>
        )}
        <span id="save-note" class="text-muted-foreground">
          {note}
        </span>
      </div>
    </form>
  );
}
