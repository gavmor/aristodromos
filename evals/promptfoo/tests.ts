// The dataset, as promptfoo test cases.
//
// Why TS and not YAML rows: the stimulus is a typed `Scene`, and a YAML literal
// of one is unverifiable — a renamed field in `utils/scene.ts` would rot the
// fixture silently and `tsc` would never see it. Promptfoo's `tests: file://`
// hook takes a module, so we keep the dataset typechecked and hand promptfoo
// scalar vars for its results table. The Scene itself is resolved by `caseId`
// inside the provider and the graders.
import { STEERABILITY_CASES, offeredActionIds } from '../steerability';

export default function steerabilityTests() {
  return STEERABILITY_CASES.map((steerCase) => ({
    description: `${steerCase.id}: ${steerCase.description}`,
    vars: {
      caseId: steerCase.id,
      goal: steerCase.goal,
      correctActionId: steerCase.correctActionId,
      distractorActionId: steerCase.distractorActionId,
      offered: offeredActionIds(steerCase.scene).join(', '),
    },
  }));
}
