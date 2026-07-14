<script setup lang="ts">
/**
 * Compact PBR swatch preview on a sphere — same material wiring as GlbViewer but
 * fixed studio lighting and no controls. Used for material library cards and for
 * offscreen thumbnail capture in the editor.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  DEFAULT_MATERIAL_PARAMETERS,
  MATERIAL_SLOTS,
  type MaterialParameters,
  type MaterialSlot,
} from '../../shared/api';
import { applyHeightPreview } from '../utils/materialHeightPreview';
import { readContainerCssSize, threePixelRatio } from '../utils/threeResize';

type SlotSources = Partial<Record<MaterialSlot, string | null>>;

const STUDIO_HDRI = '/hdri/studio_small_01_1k.hdr';
const SPHERE_RADIUS = 1;
const CAMERA_DISTANCE = 3.2;

const props = withDefaults(defineProps<{
  sources?: SlotSources;
  parameters?: MaterialParameters;
  /** When false, render one frame after textures settle (library cards). */
  live?: boolean;
}>(), {
  live: true,
});

const params = computed<MaterialParameters>(() => ({
  ...DEFAULT_MATERIAL_PARAMETERS,
  ...(props.parameters ?? {}),
}));

const wrapRef = ref<HTMLDivElement | null>(null);

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
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
const textureAspects: Partial<Record<MaterialSlot, number>> = {};
let pendingTextureLoads = 0;

let lastTransparent = false;
let lastSide: THREE.Side = THREE.FrontSide;
let lastAlphaTest = 0;

function buildGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(SPHERE_RADIUS, 64, 48);
  const uv = geo.getAttribute('uv');
  if (uv) {
    geo.setAttribute('uv1', uv.clone());
    geo.setAttribute('uv2', uv.clone());
  }
  return geo;
}

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

function applyTextureTiling(slot: MaterialSlot, tex: THREE.Texture): void {
  const p = params.value;
  const aspect = textureAspects[slot] ?? 1;
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

function assignMap(slot: MaterialSlot, tex: THREE.Texture | null): void {
  if (!material) return;
  const p = params.value;
  if (isUnlitMaterial) {
    const m = material as THREE.MeshBasicMaterial;
    if (slot === 'albedo') m.map = tex;
    else if (slot === 'opacity') m.alphaMap = tex;
    return;
  }
  const m = material as THREE.MeshPhysicalMaterial;
  switch (slot) {
    case 'albedo': m.map = tex; break;
    case 'normal':
      m.normalMap = tex;
      applyHeightPreview(m, loadedTextures.displacement ?? null, p.displacementScale, p.displacementBias);
      break;
    case 'roughness': m.roughnessMap = tex; break;
    case 'metallic':
      if (p.specularMapInMetallicSlot) {
        m.specularIntensityMap = tex;
        m.metalnessMap = null;
      } else {
        m.metalnessMap = tex;
        m.specularIntensityMap = null;
      }
      break;
    case 'ao': m.aoMap = tex; break;
    case 'emissive': m.emissiveMap = tex; break;
    case 'opacity': m.alphaMap = tex; break;
    case 'displacement':
      applyHeightPreview(m, tex, p.displacementScale, p.displacementBias);
      break;
  }
}

function ensureMaterialKind(unlit: boolean): void {
  if (!mesh || (unlit === isUnlitMaterial && material)) return;
  const prev = material;
  material = unlit
    ? new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide })
    : new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.FrontSide });
  mesh.material = material;
  isUnlitMaterial = unlit;
  lastTransparent = false;
  lastSide = THREE.FrontSide;
  lastAlphaTest = 0;
  for (const slot of MATERIAL_SLOTS) assignMap(slot, loadedTextures[slot] ?? null);
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
      pendingTextureLoads += 1;
      tex = texLoader.load(
        url,
        (loaded) => {
          pendingTextureLoads = Math.max(0, pendingTextureLoads - 1);
          let finalTex: THREE.Texture = loaded;
          if (slot === 'roughness' && params.value.roughnessInvertFromGloss) {
            finalTex = invertGrayscaleTexture(loaded);
            loaded.dispose();
          }
          const img = finalTex.image as HTMLImageElement | HTMLCanvasElement;
          const iw = (img as HTMLImageElement).naturalWidth || img.width;
          const ih = (img as HTMLImageElement).naturalHeight || img.height;
          if (iw && ih && iw !== ih) textureAspects[slot] = iw / ih;
          configureTexture(slot, finalTex);
          loadedTextures[slot] = finalTex;
          assignMap(slot, finalTex);
          material?.needsUpdate && (material.needsUpdate = true);
        },
        undefined,
        () => { pendingTextureLoads = Math.max(0, pendingTextureLoads - 1); },
      );
      configureTexture(slot, tex);
      loadedTextures[slot] = tex;
    }
    assignMap(slot, tex);
  }
  material.needsUpdate = true;
  applyParameters();
}

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
  if (nextTransparent !== lastTransparent || nextSide !== lastSide || nextAlphaTest !== lastAlphaTest) {
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
    if (tex) applyTextureTiling(slot, tex);
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
  applyHeightPreview(m, loadedTextures.displacement ?? null, p.displacementScale, p.displacementBias);
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
  if (loadedTextures.metallic) assignMap('metallic', loadedTextures.metallic);
  applyAlphaAndSide(m, p);
}

async function loadEnvironment(): Promise<void> {
  if (!renderer || !scene) return;
  try {
    const tex = await rgbeLoader.loadAsync(STUDIO_HDRI);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const newRT = pmrem.fromEquirectangular(tex);
    pmrem.dispose();
    tex.dispose();
    envRT?.dispose();
    envRT = newRT;
    scene.environment = envRT.texture;
  } catch {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    envRT?.dispose();
    envRT = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    scene.environment = envRT.texture;
  }
}

function updateCameraAspect(width: number, height: number): void {
  if (!camera) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function resize(): void {
  const wrap = wrapRef.value;
  if (!wrap || !renderer || !camera) return;
  const size = readContainerCssSize(wrap);
  if (!size) return;
  renderer.setPixelRatio(threePixelRatio());
  updateCameraAspect(size.width, size.height);
  renderer.setSize(size.width, size.height, true);
}

function animate(): void {
  if (props.live) {
    rafId = requestAnimationFrame(animate);
  }
  if (renderer && scene && camera) renderer.render(scene, camera);
}

async function renderOnceWhenReady(): Promise<void> {
  if (props.live || !renderer || !scene || !camera) return;
  await waitForReady();
  renderer.render(scene, camera);
}

function waitForReady(timeoutMs = 4000): Promise<void> {
  const started = performance.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      if (pendingTextureLoads <= 0 || performance.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

async function captureSnapshot(): Promise<string | null> {
  if (!renderer || !scene || !camera) return null;
  await waitForReady();
  renderer.render(scene, camera);
  try {
    return renderer.domElement.toDataURL('image/png');
  } catch {
    return null;
  }
}

defineExpose({ captureSnapshot, waitForReady });

onMounted(() => {
  const wrap = wrapRef.value;
  if (!wrap) return;

  const w = wrap.clientWidth || 256;
  const h = wrap.clientHeight || 256;

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(threePixelRatio());
  renderer.setSize(w, h, true);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  wrap.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(0, 0, CAMERA_DISTANCE);
  camera.lookAt(0, 0, 0);
  updateCameraAspect(w, h);

  material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mesh = new THREE.Mesh(buildGeometry(), material);
  scene.add(mesh);

  applySources(props.sources);
  applyParameters();

  resizeObs = new ResizeObserver(() => resize());
  resizeObs.observe(wrap);

  if (props.live) {
    animate();
  }
  void loadEnvironment().then(() => {
    if (!props.live) void renderOnceWhenReady();
  });
});

watch(() => props.sources, (next) => {
  applySources(next);
  if (!props.live) void renderOnceWhenReady();
}, { deep: true });
watch(() => props.parameters, () => {
  applyParameters();
  if (!props.live) void renderOnceWhenReady();
}, { deep: true });

onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  resizeObs?.disconnect();
  for (const slot of MATERIAL_SLOTS) disposeSlot(slot);
  mesh?.geometry.dispose();
  material?.dispose();
  envRT?.dispose();
  if (scene) scene.environment = null;
  const dom = renderer?.domElement;
  renderer?.dispose();
  if (dom && wrapRef.value?.contains(dom)) wrapRef.value.removeChild(dom);
  renderer = null;
  scene = null;
  camera = null;
  material = null;
  mesh = null;
  envRT = null;
});
</script>

<template>
  <div ref="wrapRef" class="material-preview-swatch" />
</template>

<style scoped>
.material-preview-swatch {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-hover);
}
.material-preview-swatch :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
  pointer-events: none;
}
</style>
