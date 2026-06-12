/**
 * Build a Three.js PBR material from a REBUS MaterialDetail so fixture meshes
 * can be painted with their assigned material. A focused subset of the
 * materials-editor GlbViewer logic: core parameters + the common slot maps.
 */
import * as THREE from 'three';
import {
  DEFAULT_MATERIAL_PARAMETERS,
  texturesApi,
  type MaterialDetail,
  type MaterialSlot,
} from '../../shared/api';

const SRGB_SLOTS = new Set<MaterialSlot>(['albedo', 'emissive']);

function assignSlotMap(m: THREE.MeshPhysicalMaterial, slot: MaterialSlot, tex: THREE.Texture): void {
  switch (slot) {
    case 'albedo': m.map = tex; break;
    case 'normal': m.normalMap = tex; break;
    case 'roughness': m.roughnessMap = tex; break;
    case 'metallic': m.metalnessMap = tex; break;
    case 'ao': m.aoMap = tex; break;
    case 'emissive': m.emissiveMap = tex; break;
    case 'opacity': m.alphaMap = tex; break;
    // NOTE: the 'displacement' slot is intentionally NOT applied. A
    // displacementMap moves vertices along their normals (Three default
    // displacementScale = 1 metre), which shatters fixture meshes that aren't
    // subdivided/UV'd for it. Displacement stays a materials-editor preview-only
    // feature.
  }
}

export interface BuiltMaterial {
  material: THREE.MeshPhysicalMaterial;
  textures: THREE.Texture[];
}

/** Construct a MeshPhysicalMaterial (+ owned textures for disposal) from a material. */
export function buildFixturePbrMaterial(
  detail: MaterialDetail,
  texLoader: THREE.TextureLoader,
  maxAnisotropy = 1,
): BuiltMaterial {
  const p = { ...DEFAULT_MATERIAL_PARAMETERS, ...detail.parameters };
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.baseColor),
    roughness: p.roughness,
    metalness: p.metallic,
    side: p.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  material.emissive = new THREE.Color(p.emissiveColor);
  material.emissiveIntensity = p.emissiveIntensity * (p.emissiveStrength ?? 1);
  material.opacity = p.opacity;
  material.transparent = p.opacity < 1;
  material.aoMapIntensity = p.aoIntensity;
  material.normalScale.set(p.normalScale, (p.flipNormalY ? -1 : 1) * p.normalScale);
  // Never displace fixture geometry (no displacementMap is assigned either).
  material.displacementScale = 0;
  material.clearcoat = p.clearCoatFactor;
  material.clearcoatRoughness = p.clearCoatRoughness;

  const textures: THREE.Texture[] = [];
  for (const slot of detail.slots) {
    const tex = texLoader.load(texturesApi.downloadUrl(slot.textureId));
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = maxAnisotropy;
    if (SRGB_SLOTS.has(slot.slot)) tex.colorSpace = THREE.SRGBColorSpace;
    assignSlotMap(material, slot.slot, tex);
    textures.push(tex);
  }
  material.needsUpdate = true;
  return { material, textures };
}
