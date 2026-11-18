// The goal/brain/System One/tracing form, shared by the DevTools panel and the
// toolbar popup. It renders from `browser.storage.local` and re-renders on every
// change there, so no field can show anything but the stored config. It knows
// nothing of DevTools or of any tab: whoever mounts it decides what saving means
// beyond storing the config.
import { type AgentConfig, CONFIG_KEY, resolveConfig, SUGGESTED_SYSTEM_ONE, SUGGESTED_TRACING } from './agent-config';

const MARKUP = `
  <label>
    Goal <small>(empty = idle)</small>
    <textarea id="goal" rows="3"></textarea>
  </label>
  <details id="brain">
    <summary>Brain</summary>
    <div class="row">
      <label>Model <input id="model" required /></label>
      <label>Ollama base URL <input id="base-url" type="url" required /></label>
    </div>
    <fieldset id="so-fields">
      <legend>
        <label class="inline"><input id="so-enabled" type="checkbox" /> System One in front</label>
      </legend>
      <div class="row">
        <label>Base URL <input id="so-base-url" type="url" required /></label>
        <label>Model <input id="so-model" required /></label>
        <label>Threshold <input id="so-threshold" type="number" min="0" max="1" step="0.05" required /></label>
      </div>
    </fieldset>
    <fieldset id="tr-fields">
      <legend>
        <label class="inline"><input id="tr-enabled" type="checkbox" /> Trace each decision (OTLP, e.g. Phoenix)</label>
      </legend>
      <div class="row">
        <label>Traces endpoint <input id="tr-endpoint" type="url" required /></label>
        <label>Project <input id="tr-project" required /></label>
      </div>
    </fieldset>
  </details>
  <div class="actions">
    <button id="submit-config" type="submit"></button>
    <span id="save-note" class="muted"></span>
  </div>
`;

export interface ConfigFormOptions {
  /** the submit button's label */
  submitLabel: string;
  /** show the brain settings expanded */
  brainOpen?: boolean;
  /** run after the config is stored; its failure is shown beside the button */
  afterSave?: (config: AgentConfig) => Promise<void>;
}

/** Build the form inside `container` and bind it to the stored config. */
export function mountConfigForm(container: HTMLElement, options: ConfigFormOptions): HTMLFormElement {
  const form = document.createElement('form');
  form.id = 'config';
  form.innerHTML = MARKUP;
  container.append(form);

  const field = <T extends HTMLElement>(id: string): T => form.querySelector(`#${id}`) as T;
  const ui = {
    goal: field<HTMLTextAreaElement>('goal'),
    brain: field<HTMLDetailsElement>('brain'),
    model: field<HTMLInputElement>('model'),
    baseURL: field<HTMLInputElement>('base-url'),
    soEnabled: field<HTMLInputElement>('so-enabled'),
    soFields: field<HTMLFieldSetElement>('so-fields'),
    soBaseURL: field<HTMLInputElement>('so-base-url'),
    soModel: field<HTMLInputElement>('so-model'),
    soThreshold: field<HTMLInputElement>('so-threshold'),
    trEnabled: field<HTMLInputElement>('tr-enabled'),
    trFields: field<HTMLFieldSetElement>('tr-fields'),
    trEndpoint: field<HTMLInputElement>('tr-endpoint'),
    trProject: field<HTMLInputElement>('tr-project'),
    submit: field<HTMLButtonElement>('submit-config'),
    saveNote: field<HTMLSpanElement>('save-note'),
  };
  ui.submit.textContent = options.submitLabel;
  ui.brain.open = options.brainOpen === true;

  const syncOptionalFields = (): void => {
    // A disabled fieldset skips validation and is left out of the saved config.
    ui.soFields.disabled = !ui.soEnabled.checked;
    ui.trFields.disabled = !ui.trEnabled.checked;
  };

  const fill = (config: AgentConfig): void => {
    ui.goal.value = config.goal;
    ui.model.value = config.model;
    ui.baseURL.value = config.baseURL;
    const systemOne = config.systemOne ?? SUGGESTED_SYSTEM_ONE;
    ui.soEnabled.checked = config.systemOne !== undefined;
    ui.soBaseURL.value = systemOne.baseURL;
    ui.soModel.value = systemOne.model;
    ui.soThreshold.value = String(systemOne.threshold);
    const tracing = config.tracing ?? SUGGESTED_TRACING;
    ui.trEnabled.checked = config.tracing !== undefined;
    ui.trEndpoint.value = tracing.endpoint;
    ui.trProject.value = tracing.project;
    syncOptionalFields();
  };

  const read = (): AgentConfig => {
    const config: AgentConfig = {
      goal: ui.goal.value.trim(),
      model: ui.model.value.trim(),
      baseURL: ui.baseURL.value.trim(),
    };
    if (ui.soEnabled.checked) {
      config.systemOne = {
        baseURL: ui.soBaseURL.value.trim(),
        model: ui.soModel.value.trim(),
        threshold: Number(ui.soThreshold.value),
      };
    }
    if (ui.trEnabled.checked) {
      config.tracing = { endpoint: ui.trEndpoint.value.trim(), project: ui.trProject.value.trim() };
    }
    return config;
  };

  ui.soEnabled.addEventListener('change', syncOptionalFields);
  ui.trEnabled.addEventListener('change', syncOptionalFields);
  form.addEventListener('input', () => {
    ui.saveNote.textContent = 'unsaved';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const config = read();
    void browser.storage.local
      .set({ [CONFIG_KEY]: config })
      .then(() => options.afterSave?.(config))
      .then(
        () => {
          ui.saveNote.textContent = `saved ${new Date().toLocaleTimeString()}`;
        },
        (error: unknown) => {
          ui.saveNote.textContent = `failed: ${String(error)}`;
        },
      );
  });

  // Storage is the record: every change to it is what the form shows.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && CONFIG_KEY in changes) fill(resolveConfig(changes[CONFIG_KEY].newValue));
  });
  void browser.storage.local.get(CONFIG_KEY).then((stored) => fill(resolveConfig(stored[CONFIG_KEY])));

  return form;
}
