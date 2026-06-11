<script setup lang="ts">
/**
 * three.js PBR material preview — enhanced with HDRI environments, environment
 * rotation, exposure control, tone mapping switcher, and background control.
 *
 * HDRI presets (CC0, Poly Haven) are bundled under /public/hdri/ so no external
 * requests are made at runtime. Falls back to a procedural RoomEnvironment when
 * a preset fails to load (e.g. dev without the public/ directory).
 *
 * Aspect-ratio UV correction (PBR.One technique): non-square source textures have
 * their `repeat.x` scaled by the inverse aspect so tiles appear undistorted.
 *
 * three r151+ renamed the aoMap UV channel from `uv2` to `uv1`; we duplicate
 * `uv` into BOTH so ambient occlusion shows regardless of the runtime version.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
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
type EnvPreset = 'studio' | 'outdoor' | 'workshop' | 'night';
type ToneMap = 'aces' | 'agx' | 'neutral' | 'none';
type BgMode = 'none' | 'env' | 'grey';

const HDRI_PRESETS: Record<EnvPreset, { label: string; file: string }> = {
  studio:   { label: 'Studio',   file: '/hdri/studio_small_01_1k.hdr' },
  outdoor:  { label: 'Outdoor',  file: '/hdri/the_sky_is_on_fire_1k.hdr' },
  workshop: { label: 'Workshop', file: '/hdri/artist_workshop_1k.hdr' },
  night:    { label: 'Night',    file: '/hdri/moonlit_golf_1k.hdr' },
};

const TONE_MAPPING_OPTIONS: { id: ToneMap; label: string; value: THREE.ToneMapping }[] = [
  { id: 'aces',    label: 'ACES',    value: THREE.ACESFilmicToneMapping },
  { id: 'agx',     label: 'AgX',     value: (THREE as unknown as Record<string, THREE.ToneMapping>)['AgXToneMapping'] ?? THREE.ACESFilmicToneMapping },
  { id: 'neutral', label: 'Neutral', value: (THREE as unknown as Record<string, THREE.ToneMapping>)['NeutralToneMapping'] ?? THREE.ACESFilmicToneMapping },
  { id: 'none',    label: 'Off',     value: THREE.NoToneMapping },
];

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

// --- viewer-local controls (not persisted to material parameters) ------------
const activeShape   = ref<Shape>('sphere');
const activeEnv     = ref<EnvPreset>('studio');
const envRotation   = ref(0);       // degrees 0–360
const exposure      = ref(1.0);     // 0.1–3.0
const toneMapping   = ref<ToneMap>('aces');
const bgMode        = ref<BgMode>('none');
const envLoading    = ref(false);

// --- non-reactive three.js handles (plain refs, never proxied by Vue) --------
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let material: THREE.MeshPhysicalMaterial | THREE.MeshBasicMaterial | null = null;
let isUnlitMaterial = false;
let mesh: THREE.Mesh | null = null;
let envRT: THREE.WebGLRenderTarget | null = null;
let resizeObs: ResizeObserver | null = null;
let rafId: number | null = null;

const texLoader = new THREE.TextureLoader();
const rgbeLoader = new RGBELoader();
const loadedTextures: Partial<Record<MaterialSlot, THREE.Texture>> = {};
const currentUrls: Partial<Record<MaterialSlot, string | null>> = {};
/** Aspect ratios of loaded textures (width / height) for UV correction. */
const textureAspects: Partial<Record<MaterialSlot, number>> = {};

let lastTransparent = false;
let lastSide: THREE.Side = THREE.FrontSide;
let lastAlphaTest = 0;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function buildGeometry(shape: Shape): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry;
  if (shape === 'sphere') geo = new THREE.SphereGeometry(1, 160, 120);
  else if (shape === 'cube') geo = new THREE.BoxGeometry(1.4, 1.4, 1.4, 80, 80, 80);
  else geo = new THREE.PlaneGeometry(2.2, 2.2, 256, 256);

  const uv = geo.getAttribute('uv');
  if (uv) {
    geo.setAttribute('uv1', uv.clone());
    geo.setAttribute('uv2', uv.clone());
  }
  return geo;
}

// ---------------------------------------------------------------------------
// Texture helpers
// ---------------------------------------------------------------------------

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

/**
 * Apply tiling/offset to a texture, accounting for non-square aspect ratio.
 * Non-square textures (e.g. 2:1 panoramic trim sheets) would otherwise appear
 * stretched; scaling repeat.x by 1/aspect preserves the texture's proportions.
 */
function applyTextureTiling(slot: MaterialSlot, tex: THREE.Texture): void {
  const p = params.value;
  const aspect = textureAspects[slot] ?? 1;
  // Correct for non-square: divide X tiling by aspect so a 2:1 texture
  // tiles at half the density in X, appearing the same density as Y.
  tex.repeat.set(aspect !== 1 ? p.tilingX / aspect : p.tilingX, p.tilingY);
  tex.offset.set(p.offsetX, p.offsetY);
}

function configureTexture(slot: MaterialSlot, tex: THREE.Texture): void {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  applyTextureTiling(slot, tex);
  if (slot === 'albedo' || slot === 'emissive') tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  tex.needsUpdate = true;
}

function disposeSlot(slot: MaterialSlot): void {
  const t = loadedTextures[slot];
  if (t) {
    t.dispose();
    delete loadedTextures[slot];
    delete textureAspects[slot];
  }
}

// ---------------------------------------------------------------------------
// Material slot wiring
// ---------------------------------------------------------------------------

function assignMap(slot: MaterialSlot, tex: THREE.Texture | null): void {
  if (!material) return;
  const p = params.value;
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

function ensureMaterialKind(unlit: boolean): void {
  if (!mesh || (unlit === isUnlitMaterial && material)) return;

  const prev = material;
  if (unlit) {
    material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide });
  } else {
    material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.FrontSide });
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
      tex = texLoader.load(url, (loaded) => {
        let finalTex: THREE.Texture = loaded;
        if (slot === 'roughness' && params.value.roughnessInvertFromGloss) {
          finalTex = invertGrayscaleTexture(loaded);
          loaded.dispose();
        }
        // Record aspect ratio after image is available.
        const img = finalTex.image as HTMLImageElement | HTMLCanvasElement;
        const iw = (img as HTMLImageElement).naturalWidth || img.width;
        const ih = (img as HTMLImageElement).naturalHeight || img.height;
        if (iw && ih && iw !== ih) textureAspects[slot] = iw / ih;
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
  material.needsUpdate = true;
  applyParameters();
}

// ---------------------------------------------------------------------------
// PBR parameters
// ---------------------------------------------------------------------------

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
    applyTextureTiling(slot, tex);
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
  m.opacity = p.transmissionFactor > 0 ? 1 : p.opacity;
  m.aoMapIntensity = p.aoIntensity;
  m.displacementScale = p.displacementScale;
  m.displacementBias = p.displacementBias;
  m.normalScale.set(p.normalScale, p.flipNormalY ? -p.normalScale : p.normalScale);

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

  const metallicTex = loadedTextures.metallic;
  if (metallicTex) assignMap('metallic', metallicTex);

  applyAlphaAndSide(m, p);
}

// ---------------------------------------------------------------------------
// Viewer controls
// ---------------------------------------------------------------------------

/** Update scene.background based on current bgMode. */
function applyBackground(): void {
  if (!scene) return;
  if (bgMode.value === 'env') {
    scene.background = envRT?.texture ?? null;
  } else if (bgMode.value === 'grey') {
    scene.background = new THREE.Color(0x777777);
  } else {
    scene.background = null;
  }
}

/** Apply environment azimuth rotation. */
function applyEnvRotation(): void {
  if (!scene) return;
  (scene as unknown as { environmentRotation: THREE.Euler }).environmentRotation.y =
    (envRotation.value * Math.PI) / 180;
}

/** Apply tone mapping + exposure. Changing toneMapping requires shader recompile. */
function applyToneMapping(): void {
  if (!renderer) return;
  const opt = TONE_MAPPING_OPTIONS.find((o) => o.id === toneMapping.value);
  if (opt) renderer.toneMapping = opt.value;
  renderer.toneMappingExposure = exposure.value;
  if (material) material.needsUpdate = true;
}

/**
 * Load an HDRI preset via RGBELoader + PMREMGenerator.
 * Falls back to a synthetic RoomEnvironment on failure so the viewer never breaks.
 */
async function loadEnvironment(): Promise<void> {
  if (!renderer || !scene) return;
  envLoading.value = true;
  try {
    const preset = HDRI_PRESETS[activeEnv.value];
    const tex = await rgbeLoader.loadAsync(preset.file);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const newRT = pmrem.fromEquirectangular(tex);
    pmrem.dispose();
    tex.dispose();

    const old = envRT;
    envRT = newRT;
    scene.environment = envRT.texture;
    old?.dispose();
  } catch (e) {
    console.warn('[GlbViewer] HDRI load failed, using procedural environment', e);
    if (!envRT) {
      // First load failed — fall back to procedural RoomEnvironment
      const pmrem = new THREE.PMREMGenerator(renderer!);
      const room = new RoomEnvironment();
      envRT = pmrem.fromScene(room, 0.04);
      room.dispose();
      pmrem.dispose();
      scene.environment = envRT.texture;
    }
  } finally {
    envLoading.value = false;
    applyBackground();
    applyEnvRotation();
  }
}

// ---------------------------------------------------------------------------
// Geometry switching
// ---------------------------------------------------------------------------

function setShape(shape: Shape): void {
  if (shape === activeShape.value && mesh) return;
  activeShape.value = shape;
  if (!mesh) return;
  const next = buildGeometry(shape);
  mesh.geometry.dispose();
  mesh.geometry = next;
}

// ---------------------------------------------------------------------------
// Resize + RAF loop
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const wrapRef = ref<HTMLDivElement | null>(null);

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

  // Backup direct lighting (supplemental to IBL).
  const ambient = new THREE.AmbientLight(0xffffff, 0.2);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(3, 5, 2);
  scene.add(ambient, dir);

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(0, 0, 3.4);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.4;
  controls.maxDistance = 12;

  material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.FrontSide });
  isUnlitMaterial = false;
  mesh = new THREE.Mesh(buildGeometry(activeShape.value), material);
  scene.add(mesh);

  applySources(props.sources);
  applyParameters();

  resizeObs = new ResizeObserver(() => resize());
  resizeObs.observe(wrap);

  animate();

  // Load HDRI asynchronously after the RAF loop starts so the canvas is visible.
  void loadEnvironment();
});

watch(() => props.sources, (next) => applySources(next), { deep: true });
watch(() => props.parameters, () => applyParameters(), { deep: true });

watch(activeEnv, () => void loadEnvironment());
watch(envRotation, () => applyEnvRotation());
watch(exposure, () => { if (renderer) { renderer.toneMappingExposure = exposure.value; } });
watch(toneMapping, () => applyToneMapping());
watch(bgMode, () => applyBackground());

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
    <!-- Top: shape tabs + environment preset -->
    <div class="viewer-top-bar">
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
      <select
        v-model="activeEnv"
        class="env-select"
        :disabled="envLoading"
        title="Environment lighting"
      >
        <option v-for="(preset, key) in HDRI_PRESETS" :key="key" :value="key">
          {{ envLoading && activeEnv === key ? '⟳ ' : '' }}{{ preset.label }}
        </option>
      </select>
    </div>

    <!-- Canvas -->
    <div ref="wrapRef" class="canvas-wrap" />

    <!-- Bottom controls bar -->
    <div class="viewer-controls">
      <!-- Environment rotation -->
      <label class="ctrl-group" title="Environment rotation">
        <span class="ctrl-label">↻</span>
        <input
          type="range"
          v-model.number="envRotation"
          min="0"
          max="360"
          step="1"
          class="ctrl-slider"
        />
      </label>

      <!-- Exposure -->
      <label class="ctrl-group" title="Exposure">
        <span class="ctrl-label">EV</span>
        <input
          type="range"
          v-model.number="exposure"
          min="0.1"
          max="3.0"
          step="0.05"
          class="ctrl-slider"
        />
        <span class="ctrl-value">{{ exposure.toFixed(1) }}</span>
        <button
          v-if="exposure !== 1.0"
          class="ctrl-reset"
          type="button"
          title="Reset exposure"
          @click="exposure = 1.0"
        >×</button>
      </label>

      <!-- Tone mapping -->
      <div class="ctrl-btn-group" title="Tone mapping">
        <button
          v-for="opt in TONE_MAPPING_OPTIONS"
          :key="opt.id"
          type="button"
          class="ctrl-btn"
          :class="{ active: toneMapping === opt.id }"
          @click="toneMapping = opt.id"
        >{{ opt.label }}</button>
      </div>

      <!-- Background -->
      <div class="ctrl-btn-group" title="Background">
        <button type="button" class="ctrl-btn" :class="{ active: bgMode === 'none' }" @click="bgMode = 'none'" title="Transparent">·</button>
        <button type="button" class="ctrl-btn" :class="{ active: bgMode === 'env' }"  @click="bgMode = 'env'"  title="Environment">⬡</button>
        <button type="button" class="ctrl-btn" :class="{ active: bgMode === 'grey' }" @click="bgMode = 'grey'" title="Grey">▪</button>
      </div>
    </div>
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
  display: flex;
  flex-direction: column;
}

/* --- top bar --- */
.viewer-top-bar {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
}

.shape-tabs {
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

.env-select {
  height: 26px;
  padding: 0 6px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg-elevated) 82%, transparent);
  color: var(--color-text);
  cursor: pointer;
  box-shadow: var(--shadow-1);
}
.env-select:disabled { opacity: 0.6; }

/* --- canvas --- */
.canvas-wrap {
  position: absolute;
  inset: 0;
  bottom: 34px; /* leave room for controls bar */
}
.canvas-wrap :deep(canvas) { display: block; }

/* --- bottom controls bar --- */
.viewer-controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: color-mix(in srgb, var(--color-bg-elevated) 88%, transparent);
  border-top: 1px solid var(--color-border);
  z-index: 5;
}

.ctrl-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.ctrl-label {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  user-select: none;
}

.ctrl-slider {
  flex: 1;
  min-width: 40px;
  height: 3px;
  accent-color: var(--orbit-primary);
  cursor: pointer;
}

.ctrl-value {
  font-size: 11px;
  color: var(--color-text-muted);
  width: 24px;
  text-align: right;
  white-space: nowrap;
}

.ctrl-reset {
  font-size: 11px;
  color: var(--color-text-muted);
  background: none;
  border: none;
  padding: 0 2px;
  cursor: pointer;
  line-height: 1;
}
.ctrl-reset:hover { color: var(--color-text); }

.ctrl-btn-group {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-input);
  flex-shrink: 0;
}

.ctrl-btn {
  padding: 1px 7px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  white-space: nowrap;
}
.ctrl-btn:hover { color: var(--color-text); }
.ctrl-btn.active {
  background: var(--orbit-primary);
  border-color: var(--orbit-primary);
  color: #fff;
}
</style>
