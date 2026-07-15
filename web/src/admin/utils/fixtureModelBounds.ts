import * as THREE from 'three';
import type { FixtureModel } from '../../shared/api';
import {
  computeModelPartLocalBounds,
  loadFixtureModelGlb,
} from './fixtureAssembly';

/**
 * Load a fixture model GLB and return its part-local bounding box after the
 * same wrap rules used in the assembly (per-axis fit to GDTF L×W×H).
 */
export async function loadModelBoundsFromUrl(
  url: string,
  model: FixtureModel | undefined,
  _oneToOne?: boolean,
): Promise<THREE.Box3 | null> {
  const meshRoot = await loadFixtureModelGlb(url);
  if (!meshRoot) return null;
  return computeModelPartLocalBounds(meshRoot, model);
}
