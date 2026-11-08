// Semantic page map and up-edge normalization.
//
// The content script perceives the live page, extracts salient affordances, and
// streams this representation to the background service worker using fast-json-patch.
//
// Separates convergent state targets (idempotent mutations) from trigger
// elements (one-shot actions). No risk levels, affordance masking, or delivery-layer
// tracking are held here; perception reports the current observed representation.
import { applyPatch, type Operation } from 'fast-json-patch';

/**
 * Idempotent, convergent affordance accepting a target state or value.
 */
export interface StateTargetAffordance {
  id: string;
  type: string;
  label: string;
  current_value: string | number | boolean;
}

export type StateTargetItem = StateTargetAffordance;

/**
 * One-shot trigger affordance executing discrete side-effects when actuated.
 */
export interface TriggerElementAffordance {
  id: string;
  type: string;
  label: string;
}

export type TriggerElementItem = TriggerElementAffordance;

/**
 * Distilled semantic page map sent up from content script to background policy.
 */
export interface SemanticPageMap {
  document_id?: string;
  title?: string;
  state_targets: StateTargetAffordance[];
  trigger_elements: TriggerElementAffordance[];
}

/**
 * Wire-level representation of an affordance target before normalization.
 */
export interface WireStateTarget {
  id?: string | number | null;
  type?: string | null;
  label?: string | null;
  current_value?: string | number | boolean | null;
  currentValue?: string | number | boolean | null;
  is_idempotent?: boolean;
  [key: string]: unknown;
}

/**
 * Wire-level representation of a trigger element before normalization.
 */
export interface WireTriggerElement {
  id?: string | number | null;
  type?: string | null;
  label?: string | null;
  is_idempotent?: boolean;
  risk_level?: string;
  side_effect_hint?: string;
  [key: string]: unknown;
}

/**
 * Wire-level document format emitted by the up-edge projection engine.
 */
export interface WireSemanticPageMap {
  document_id?: string | null;
  documentId?: string | null;
  title?: string | null;
  state_targets?: WireStateTarget[] | null;
  stateTargets?: WireStateTarget[] | null;
  trigger_elements?: WireTriggerElement[] | null;
  triggerElements?: WireTriggerElement[] | null;
  [key: string]: unknown;
}

/**
 * Normalize an individual wire state target into an internal StateTargetAffordance.
 * Preserves labels when present; defaults missing/null labels to empty string.
 * Strips wire-only flags like is_idempotent or risk annotations.
 */
export function normalizeStateTarget(raw: WireStateTarget): StateTargetAffordance {
  const rawValue = raw.current_value !== undefined ? raw.current_value : raw.currentValue;
  const val = rawValue === null || rawValue === undefined ? '' : rawValue;

  return {
    id: raw.id != null ? String(raw.id) : '',
    type: raw.type != null ? String(raw.type) : 'text_input',
    label: raw.label != null ? String(raw.label) : '',
    current_value: val,
  };
}

/**
 * Normalize an individual wire trigger element into an internal TriggerElementAffordance.
 * Preserves labels when present; defaults missing/null labels to empty string.
 * Strips wire-only fields like risk_level, side_effect_hint, and is_idempotent.
 */
export function normalizeTriggerElement(raw: WireTriggerElement): TriggerElementAffordance {
  return {
    id: raw.id != null ? String(raw.id) : '',
    type: raw.type != null ? String(raw.type) : 'button_click',
    label: raw.label != null ? String(raw.label) : '',
  };
}

/**
 * Normalize the wire format into internal SemanticPageMap types.
 *
 * Missing labels become empty strings, never dropped. Content-script risk_level,
 * affordance masks, and delivery hints are ignored.
 */
export function normalizeSemanticPageMap(wire: unknown): SemanticPageMap {
  if (!wire || typeof wire !== 'object') {
    return {
      state_targets: [],
      trigger_elements: [],
    };
  }

  const raw = wire as WireSemanticPageMap;
  const rawTargets = Array.isArray(raw.state_targets)
    ? raw.state_targets
    : Array.isArray(raw.stateTargets)
      ? raw.stateTargets
      : [];

  const rawTriggers = Array.isArray(raw.trigger_elements)
    ? raw.trigger_elements
    : Array.isArray(raw.triggerElements)
      ? raw.triggerElements
      : [];

  const map: SemanticPageMap = {
    state_targets: rawTargets.map(normalizeStateTarget),
    trigger_elements: rawTriggers.map(normalizeTriggerElement),
  };

  const docId = raw.document_id ?? raw.documentId;
  if (docId != null) {
    map.document_id = String(docId);
  }

  if (raw.title != null) {
    map.title = String(raw.title);
  }

  return map;
}

/**
 * Pure function that applies a fast-json-patch stream to the current semantic map.
 * Holds no hidden module state: current map + patch in, new map out.
 */
export function applySemanticPatch(
  map: SemanticPageMap,
  patch: Operation | Operation[],
): SemanticPageMap {
  const ops = Array.isArray(patch) ? patch : [patch];
  if (ops.length === 0) {
    return {
      ...map,
      state_targets: [...map.state_targets],
      trigger_elements: [...map.trigger_elements],
    };
  }

  // fast-json-patch with mutateDocument=false returns a new cloned document
  const result = applyPatch(map, ops, false, false);
  return result.newDocument as SemanticPageMap;
}
