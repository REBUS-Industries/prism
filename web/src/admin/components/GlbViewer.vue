<script setup lang="ts">
/**
 * three.js PBR material preview.
 *
 * Renders a MeshPhysicalMaterial (or MeshBasicMaterial when `unlit`) on a
 * swappable Sphere / Cube / Plane and wires the eight PBR slots onto the
 * corresponding material maps. The parent passes a slot -> URL map (`sources`);
 * each URL is either a blob URL (pre-save) or `/api/textures/:id/download`
 * (post-save), loaded same-origin so the admin session cookie rides along.
 *
 * Environment lighting comes from a PMREM-prefiltered RoomEnvironment so PBR
 * reflections look correct without shipping an HDRI; a directional + ambient
 * light act as a backup. Lifecycle discipline mirrors PixelStreamingPlayer:
 * the RAF loop, ResizeObserver, renderer, geometries, material, textures and
 * controls are all torn down in onBeforeUnmount.
 *
 * three r151+ renamed the aoMap UV channel from `uv2` to `uv1`; we duplicate
 * `uv` into BOTH so ambient occlusion shows regardless of the runtime version.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  MATERIAL_SLOTS,
  DEFAULT_MATERIAL_PARAMETERS,
  type MaterialParameters,
  type MaterialSlot,
} from '../../shared/api';
import { readContainerCssSize, threePixelRatio } from '../utils/threeResize';

type SlotSources = Partial<Record<MaterialSlot, string | null>>;
type Shape = 'sphere' | 'cube' | 'plane';

const props = defineProps<{
  /** slot -> texture URL (blob URL pre-save, or /api/textures/:id/download). */
  sources?: SlotSources;
  /** Complete PBR parameter set, applied live onto the material. */
  parameters?: MaterialParameters;
}>();

const params = computed<MaterialParameters>(() => ({
  ...DEFAULT_MATERIAL_PARAMETERS,
  ...(props.parameters ?? {}),
}));

const wrapRef = ref<HTMLDivElement | null>(null);
const activeShape = ref<Shape>('sphere');

// --- non-reactive three.js handles (plain refs, never proxied by Vue) -------
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let material: THREE.MeshPhysicalMaterial | THREE.MeshBasicMaterial | null = null;
/** Tracks whether the live material is the unlit (basic) variant. */
let isUnlitMaterial = false;
let mesh: THREE.Mesh | null = null;
let envRT: THREE.WebGLRenderTarget | null = null;
let resizeObs: ResizeObserver | null = null;
let rafId: number | null = null;

const loader = new THREE.TextureLoader();
const loadedTextures: Partial<Record<MaterialSlot, THREE.Texture>> = {};
const currentUrls: Partial<Record<MaterialSlot, string | null>> = {};

// Track the last structural state we pushed so we only flag a (costly) shader
// recompile when `side` / `transparent` actually flip — plain scalar/colour
// tweaks are uniform updates and need no needsUpdate.
let lastTransparent = false;
let lastSide: THREE.Side = THREE.FrontSide;
let lastAlphaTest = 0;

function buildGeometry(shape: Shape): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry;
  if (shape === 'sphere') geo = new THREE.SphereGeometry(1, 160, 120);
  else if (shape === 'cube') geo = new THREE.BoxGeometry(1.4, 1.4, 1.4, 80, 80, 80);
  else geo = new THREE.PlaneGeometry(2.2, 2.2, 256, 256);

  // aoMap needs a second UV set. three r151+ reads `uv1`; older builds read
  // `uv2` — set both so ambient occlusion shows on either.
  const uv = geo.getAttribute('uv');
  if (uv) {
    geo.setAttribute('uv1', uv.clone());
    geo.setAttribute('uv2', uv.clone());
  }
  return geo;
}

/** Invert a loaded grayscale map (gloss → roughness) for preview. */
function invertGrayscaleTexture(source: THREE.Texture): THREE.Texture {
  const img = source.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
  const w = img.width as number;
  const h = img.height as number;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return source;
  ctx.drawImage(img as CanvasImageSource, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i]!;
    d[i + 1] = 255 - d[i + 1]!;
    d[i + 2] = 255 - d[i + 2]!;
  }
  ctx.putImageData(imageData, 0, 0);
  const inverted = new THREE.CanvasTexture(canvas);
  inverted.wrapS = source.wrapS;
  inverted.wrapT = source.wrapT;
  inverted.repeat.copy(source.repeat);
  inverted.offset.copy(source.offset);
  inverted.anisotropy = source.anisotropy;
  inverted.needsUpdate = true;
  return inverted;
}

function configureTexture(slot: MaterialSlot, tex: THREE.Texture): void {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Seed tiling/offset so a freshly loaded map is correct on its first frame;
  // applyParameters keeps them live thereafter via the texture matrix (no
  // per-tick needsUpdate, which would re-upload the image).
  tex.repeat.set(params.value.tilingX, params.value.tilingY);
  tex.offset.set(params.value.offsetX, params.value.offsetY);
  // Colour maps live in sRGB; data maps (normal/roughness/metalness/ao/
  // displacement/alpha) stay linear (the loader's NoColorSpace default).
  if (slot === 'albedo' || slot === 'emissive') tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  tex.needsUpdate = true;
}

function disposeSlot(slot: MaterialSlot): void {
  const t = loadedTextures[slot];
  if (t) {
    t.dispose();
    delete loadedTextures[slot];
  }
}

function assignMap(slot: MaterialSlot, tex: THREE.Texture | null): void {
  if (!material) return;
  const p = params.value;
  // Map references only — every scalar/colour comes from applyParameters so the
  // stored PBR parameters stay the single source of truth (e.g. a roughnessMap
  // is scaled by the `roughness` multiplier, not reset to 1).
  if (isUnlitMaterial) {
    const m = material as THREE.MeshBasicMaterial;
    switch (slot) {
      case 'albedo':  m.map = tex; break;
      case 'opacity': m.alphaMap = tex; break;
    }
    return;
  }
  const m = material as THREE.MeshPhysicalMaterial;
  switch (slot) {
    case 'albedo':       m.map = tex; break;
    case 'normal':       m.normalMap = tex; break;
    case 'roughness':    m.roughnessMap = tex; break;
    case 'metallic':
      if (p.specularMapInMetallicSlot) {
        m.specularIntensityMap = tex;
        m.metalnessMap = null;
      } else {
        m.metalnessMap = tex;
        m.specularIntensityMap = null;
      }
      break;
    case 'ao':           m.aoMap = tex; break;
    case 'emissive':     m.emissiveMap = tex; break;
    case 'opacity':      m.alphaMap = tex; break;
    case 'displacement': m.displacementMap = tex; break;
  }
}

/** Swap between lit (physical) and unlit (basic) materials when the flag flips. */
function ensureMaterialKind(unlit: boolean): void {
  if (!mesh || (unlit === isUnlitMaterial && material)) return;

  const prev = material;
  if (unlit) {
    material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.FrontSide,
    });
  } else {
    material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      side: THREE.FrontSide,
    });
  }
  mesh.material = material;
  isUnlitMaterial = unlit;
  lastTransparent = false;
  lastSide = THREE.FrontSide;
  lastAlphaTest = 0;

  for (const slot of MATERIAL_SLOTS) {
    assignMap(slot, loadedTextures[slot] ?? null);
  }

  prev?.dispose();
  material.needsUpdate = true;
}

function applySources(next: SlotSources | undefined): void {
  if (!material) return;
  for (const slot of MATERIAL_SLOTS) {
    const url = next?.[slot] ?? null;
    if (url === (currentUrls[slot] ?? null)) continue;
    currentUrls[slot] = url;
    disposeSlot(slot);
    let tex: THREE.Texture | null = null;
    if (url) {
      tex = loader.load(url, (loaded) => {
        let finalTex: THREE.Texture = loaded;
        if (slot === 'roughness' && params.value.roughnessInvertFromGloss) {
          finalTex = invertGrayscaleTexture(loaded);
          loaded.dispose();
        }
        configureTexture(slot, finalTex);
        loadedTextures[slot] = finalTex;
        assignMap(slot, finalTex);
        if (material) material.needsUpdate = true;
      });
      configureTexture(slot, tex);
      loadedTextures[slot] = tex;
    }
    assignMap(slot, tex);
  }
  // Maps added/removed → recompile, then re-apply parameters (transparent
  // depends on alphaMap presence; new maps need current tiling/offset).
  material.needsUpdate = true;
  applyParameters();
}

/**
 * Mutate every PBR property in place from the current `parameters`. Colours and
 * scalars are uniform updates (cheap); only a side/transparent flip flags a
 * shader recompile. Texture tiling/offset ride the texture matrix so no
 * per-tick image re-upload is needed.
 */
function applyAlphaAndSide(
  m: THREE.MeshPhysicalMaterial | THREE.MeshBasicMaterial,
  p: MaterialParameters,
): void {
  const hasAlphaMap = !!m.alphaMap;
  const hasTransmission = !isUnlitMaterial && (m as THREE.MeshPhysicalMaterial).transmission > 0;

  let nextTransparent: boolean;
  let nextAlphaTest: number;
  if (p.alphaMode === 'blend') {
    nextTransparent = true;
    nextAlphaTest = 0;
  } else if (p.alphaMode === 'mask') {
    nextTransparent = false;
    nextAlphaTest = p.alphaCutoff;
  } else {
    nextAlphaTest = 0;
    nextTransparent = p.opacity < 1 || hasAlphaMap || hasTransmission;
  }

  const nextSide: THREE.Side = p.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  m.transparent = nextTransparent;
  m.alphaTest = nextAlphaTest;
  m.side = nextSide;

  if (
    nextTransparent !== lastTransparent
    || nextSide !== lastSide
    || nextAlphaTest !== lastAlphaTest
  ) {
    m.needsUpdate = true;
    lastTransparent = nextTransparent;
    lastSide = nextSide;
    lastAlphaTest = nextAlphaTest;
  }
}

function applyParameters(): void {
  if (!material) return;
  const p = params.value;

  ensureMaterialKind(p.unlit);
  if (!material) return;

  for (const slot of MATERIAL_SLOTS) {
    const tex = loadedTextures[slot];
    if (!tex) continue;
    tex.repeat.set(p.tilingX, p.tilingY);
    tex.offset.set(p.offsetX, p.offsetY);
  }

  if (isUnlitMaterial) {
    const m = material as THREE.MeshBasicMaterial;
    m.color.set(p.baseColor);
    m.opacity = p.opacity;
    applyAlphaAndSide(m, p);
    return;
  }

  const m = material as THREE.MeshPhysicalMaterial;

  m.color.set(p.baseColor);
  m.roughness = p.roughness;
  m.metalness = p.metallic;
  m.emissive.set(p.emissiveColor);
  m.emissiveIntensity = p.emissiveIntensity * p.emissiveStrength;
  // Transmission and opacity interact — keep opacity at 1 when transmissive.
  m.opacity = p.transmissionFactor > 0 ? 1 : p.opacity;
  m.aoMapIntensity = p.aoIntensity;
  m.displacementScale = p.displacementScale;
  m.displacementBias = p.displacementBias;
  m.normalScale.set(p.normalScale, p.flipNormalY ? -p.normalScale : p.normalScale);

  // glTF extension scalars/colours → MeshPhysicalMaterial
  m.clearcoat = p.clearCoatFactor;
  m.clearcoatRoughness = p.clearCoatRoughness;
  m.transmission = p.transmissionFactor;
  m.ior = p.ior;
  m.specularIntensity = p.specularFactor;
  m.specularColor.set(p.specularColor);

  const sheenCol = new THREE.Color(p.sheenColor);
  const sheenLuma = Math.max(sheenCol.r, sheenCol.g, sheenCol.b);
  m.sheen = sheenLuma > 0 ? sheenLuma : (p.sheenRoughness > 0 ? 1 : 0);
  m.sheenColor.copy(sheenCol);
  m.sheenRoughness = p.sheenRoughness;

  m.thickness = p.volumeThicknessFactor;
  m.attenuationDistance = p.volumeAttenuationDistance;
  m.attenuationColor.set(p.volumeAttenuationColor);

  m.anisotropy = p.anisotropyStrength;
  m.anisotropyRotation = p.anisotropyRotation;

  m.iridescence = p.iridescenceFactor;
  m.iridescenceIOR = p.iridescenceIor;
  m.iridescenceThicknessRange = [p.iridescenceThicknessMin, p.iridescenceThicknessMax];

  m.dispersion = p.dispersionFactor;

  // Re-route metallic slot when specular-workflow flag is set.
  const metallicTex = loadedTextures.metallic;
  if (metallicTex) assignMap('metallic', metallicTex);

  applyAlphaAndSide(m, p);
}

function setShape(shape: Shape): void {
  if (shape === activeShape.value && mesh) return;
  activeShape.value = shape;
  if (!mesh) return;
  const next = buildGeometry(shape);
  mesh.geometry.dispose();
  mesh.geometry = next;
}

function resize(): void {
  const wrap = wrapRef.value;
  if (!wrap || !renderer || !camera) return;
  const size = readContainerCssSize(wrap);
  if (!size) return;
  const { width, height } = size;
  renderer.setPixelRatio(threePixelRatio());
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, true);
}

function animate(): void {
  rafId = requestAnimationFrame(animate);
  controls?.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

onMounted(() => {
  const wrap = wrapRef.value;
  if (!wrap) return;

  const w = wrap.clientWidth || 480;
  const h = wrap.clientHeight || 360;

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(threePixelRatio());
  renderer.setSize(w, h, true);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  wrap.appendChild(renderer.domElement);

  scene = new THREE.Scene();

  // Neutral prefiltered environment for correct PBR reflections.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  envRT = pmrem.fromScene(room, 0.04);
  scene.environment = envRT.texture;
  room.dispose();
  pmrem.dispose();

  // Backup direct lighting.
  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(3, 5, 2);
  scene.add(ambient, dir);

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(0, 0, 3.4);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.4;
  controls.maxDistance = 12;

  material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: THREE.FrontSide,
  });
  isUnlitMaterial = false;
  mesh = new THREE.Mesh(buildGeometry(activeShape.value), material);
  scene.add(mesh);

  applySources(props.sources);
  applyParameters();

  resizeObs = new ResizeObserver(() => resize());
  resizeObs.observe(wrap);

  animate();
});

watch(() => props.sources, (next) => applySources(next), { deep: true });
watch(() => props.parameters, () => applyParameters(), { deep: true });

onBeforeUnmount(() => {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  resizeObs?.disconnect();
  resizeObs = null;

  for (const slot of MATERIAL_SLOTS) disposeSlot(slot);

  mesh?.geometry.dispose();
  material?.dispose();
  controls?.dispose();
  envRT?.dispose();
  if (scene) scene.environment = null;

  const dom = renderer?.domElement;
  renderer?.dispose();
  if (dom && wrapRef.value?.contains(dom)) wrapRef.value.removeChild(dom);

  renderer = null;
  scene = null;
  camera = null;
  controls = null;
  material = null;
  mesh = null;
  envRT = null;
});
</script>

<template>
  <div class="glb-viewer">
    <div class="shape-tabs">
      <button
        v-for="s in (['sphere', 'cube', 'plane'] as const)"
        :key="s"
        class="shape-tab"
        :class="{ active: activeShape === s }"
        type="button"
        @click="setShape(s)"
      >{{ s[0].toUpperCase() + s.slice(1) }}</button>
    </div>
    <div ref="wrapRef" class="canvas-wrap" />
  </div>
</template>

<style scoped>
.glb-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  overflow: hidden;
}
.canvas-wrap {
  position: absolute;
  inset: 0;
}
.canvas-wrap :deep(canvas) {
  display: block;
}
.shape-tabs {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-bg-elevated) 82%, transparent);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-1);
}
.shape-tab {
  padding: 3px 12px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
}
.shape-tab:hover { color: var(--color-text); border-color: transparent; }
.shape-tab.active {
  background: var(--orbit-primary);
  border-color: var(--orbit-primary);
  color: #fff;
}
</style>
