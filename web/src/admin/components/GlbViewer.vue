<script setup lang="ts">
/**
 * three.js PBR material preview.
 *
 * Renders a single MeshStandardMaterial on a swappable Sphere / Cube / Plane
 * and wires the eight PBR slots onto the corresponding material maps. The
 * parent passes a slot -> URL map (`sources`); each URL is either a blob URL
 * (pre-save) or `/api/textures/:id/download` (post-save), loaded same-origin
 * so the admin session cookie rides along.
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
let material: THREE.MeshStandardMaterial | null = null;
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
  // Map references only — every scalar/colour comes from applyParameters so the
  // stored PBR parameters stay the single source of truth (e.g. a roughnessMap
  // is scaled by the `roughness` multiplier, not reset to 1).
  switch (slot) {
    case 'albedo':       material.map = tex; break;
    case 'normal':       material.normalMap = tex; break;
    case 'roughness':    material.roughnessMap = tex; break;
    case 'metallic':     material.metalnessMap = tex; break;
    case 'ao':           material.aoMap = tex; break;
    case 'emissive':     material.emissiveMap = tex; break;
    case 'opacity':      material.alphaMap = tex; break;
    case 'displacement': material.displacementMap = tex; break;
  }
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
      tex = loader.load(url);
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
function applyParameters(): void {
  if (!material) return;
  const p = params.value;

  material.color.set(p.baseColor);
  material.roughness = p.roughness;
  material.metalness = p.metallic;
  material.emissive.set(p.emissiveColor);
  material.emissiveIntensity = p.emissiveIntensity;
  material.opacity = p.opacity;
  material.aoMapIntensity = p.aoIntensity;
  material.displacementScale = p.displacementScale;
  material.displacementBias = p.displacementBias;
  material.normalScale.set(p.normalScale, p.flipNormalY ? -p.normalScale : p.normalScale);

  for (const slot of MATERIAL_SLOTS) {
    const tex = loadedTextures[slot];
    if (!tex) continue;
    tex.repeat.set(p.tilingX, p.tilingY);
    tex.offset.set(p.offsetX, p.offsetY);
  }

  const nextTransparent = p.opacity < 1 || !!material.alphaMap;
  const nextSide: THREE.Side = p.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  material.transparent = nextTransparent;
  material.side = nextSide;
  if (nextTransparent !== lastTransparent || nextSide !== lastSide) {
    material.needsUpdate = true;
    lastTransparent = nextTransparent;
    lastSide = nextSide;
  }
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
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
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

  material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: THREE.FrontSide,
  });
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
  min-height: 280px;
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
