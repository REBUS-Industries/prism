import type { FixtureDefinition, FixtureModel } from '../../shared/api';

/** True when the model mesh was swapped via Settings → Replace (not original GDTF). */
export function isCustomReplacedModel(model: FixtureModel | null | undefined): boolean {
  const meta = model?.metadata as { replaced?: unknown } | undefined;
  return meta?.replaced === true;
}

/** True when any model in the fixture definition carries a custom replaced mesh. */
export function fixtureHasCustomMeshes(definition: FixtureDefinition | null | undefined): boolean {
  return (definition?.models ?? []).some((m) => isCustomReplacedModel(m));
}
