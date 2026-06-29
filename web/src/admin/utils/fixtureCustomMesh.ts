import type { FixtureModel } from '../../shared/api';

/** True when the model mesh was swapped via Settings → Replace (not original GDTF). */
export function isCustomReplacedModel(model: FixtureModel | null | undefined): boolean {
  const meta = model?.metadata as { replaced?: unknown } | undefined;
  return meta?.replaced === true;
}
