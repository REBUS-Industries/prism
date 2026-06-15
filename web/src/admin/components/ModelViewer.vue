<script setup lang="ts">
/**
 * Model library 3D preview — single GLB with optional root transform gizmo.
 * Z-up authoring space (camera.up = Z; glTF meshes wrapped +90° X like fixtures).
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { readContainerCssSize, threePixelRatio } from '../utils/threeResize';
import { fetchSlotMaterials, paintModelMaterialSlots } from '../utils/modelMaterialSlots';
import { type BuiltMaterial } from '../utils/fixturePbrMaterial';
import {
  applyModelTransform,
  ensureModelTransform,
  modelTransformKey,
  readModelTransform,
} from '../utils/modelTransform';
import { type ModelMaterialSlot, type ModelTransform } from '../../shared/api';
import {
  ensureModelSourceUnits,
  unitScaleToMetres,
  type ModelLengthUnit,
} from '../utils/modelUnits';

const props = withDefaults(defineProps<{
  url: string;
  modelMaterialSlots?: ModelMaterialSlot[] | null;
  transform?: ModelTransform | null;
  /** Vertex coordinate units of the GLB; scaled to metres in the preview. */
  sourceUnits?: ModelLengthUnit | null;
  viewPreset?: 'top' | 'front' | 'side' | 'iso';
  interactive?: boolean;
  lightBackground?: boolean;
  fill?: boolean;
  editable?: boolean;
  gizmoMode?: 'translate' | 'rotate' | 'scale';
  gizmoSpace?: 'world' | 'local';
}>(), {
  modelMaterialSlots: null,
  transform: null,
  sourceUnits: null,
  viewPreset: 'iso',
  interactive: true,
  lightBackground: false,
  fill: false,
  editable: true,
  gizmoMode: 'translate',
  gizmoSpace: 'local',
});

const emit = defineEmits<{
  transformChange: [transform: ModelTransform];
}>();

const wrapRef = ref<HTMLDivElement | null>(null);
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let transformControls: TransformControls | null = null;
let transformHelper: THREE.Object3D | null = null;
let transformGroup: THREE.Group | null = null;
/** Uniform scale from mesh source units → canonical metres. */
let unitScaleGroup: THREE.Group | null = null;
/** Fixed +90° X: glTF Y-up mesh → Z-up authoring space (matches fixture GLB wrap). */
let glbOrient: THREE.Group | null = null;
let loadedRoot: THREE.Object3D | null = null;
let envRT: THREE.WebGLRenderTarget | null = null;
let resizeObs: ResizeObserver | null = null;
let rafId: number | null = null;
let modelCenter = new THREE.Vector3();
let modelSize = 1;
let lastCssW = 0;
let lastCssH = 0;
let loadToken = 0;
let gizmoDragging = false;
const texLoader = new THREE.TextureLoader();
let builtMaterials: BuiltMaterial[] = [];

function disposeBuiltMaterials(): void {
  for (const bm of builtMaterials) {
    bm.material.dispose();
    for (const t of bm.textures) t.dispose();
  }
  builtMaterials = [];
}

function clearLoaded(): void {
  transformControls?.detach();
  disposeBuiltMaterials();
  if (loadedRoot) {
    loadedRoot.removeFromParent();
    loadedRoot.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      }
    });
  }
  loadedRoot = null;
}

function dispose(): void {
  if (rafId != null) cancelAnimationFrame(rafId);
  resizeObs?.disconnect();
  controls?.dispose();
  if (transformControls) {
    transformControls.removeEventListener('objectChange', onGizmoObjectChange);
    transformControls.removeEventListener('dragging-changed', onDraggingChanged);
    transformControls.detach();
    transformHelper?.removeFromParent();
    transformControls.dispose();
    transformControls = null;
    transformHelper = null;
  }
  clearLoaded();
  transformGroup?.removeFromParent();
  transformGroup = null;
  unitScaleGroup = null;
  glbOrient = null;
  const dom = renderer?.domElement;
  renderer?.dispose();
  if (dom && wrapRef.value?.contains(dom)) wrapRef.value.removeChild(dom);
  envRT?.dispose();
  renderer = scene = camera = controls = envRT = null;
}

function applyCameraPreset(): void {
  if (!camera || !controls) return;
  const s = modelSize;
  const c = modelCenter;
  const presets: Record<string, [number, number, number]> = {
    top: [c.x, c.y + 0.001, c.z + s * 1.2],
    front: [c.x, c.y - s * 1.1, c.z + s * 0.15],
    side: [c.x + s * 1.1, c.y, c.z + s * 0.15],
    iso: [c.x + s * 0.6, c.y - s * 0.4, c.z + s * 0.8],
  };
  const pos = presets[props.viewPreset] ?? presets.iso;
  camera.position.set(pos[0], pos[1], pos[2]);
  controls.target.copy(c);
  controls.update();
}

function syncUnitScale(): void {
  if (!unitScaleGroup) return;
  const s = unitScaleToMetres(ensureModelSourceUnits(props.sourceUnits));
  unitScaleGroup.scale.set(s, s, s);
}

function syncTransformFromProps(): void {
  if (!transformGroup || gizmoDragging) return;
  applyModelTransform(transformGroup, ensureModelTransform(props.transform));
}

function syncGizmo(): void {
  if (!transformControls) return;
  if (props.editable && transformGroup) {
    transformControls.setMode(props.gizmoMode);
    transformControls.setSpace(props.gizmoSpace);
    transformControls.attach(transformGroup);
  } else {
    transformControls.detach();
  }
}

function onDraggingChanged(e: unknown): void {
  gizmoDragging = (e as { value: boolean }).value;
  if (controls) controls.enabled = props.interactive && !gizmoDragging;
}

function onGizmoObjectChange(): void {
  if (!transformGroup) return;
  emit('transformChange', readModelTransform(transformGroup));
}

function frameLoaded(): void {
  if (!transformGroup) return;
  const box = new THREE.Box3().setFromObject(transformGroup);
  if (box.isEmpty()) {
    modelSize = 1;
    modelCenter.set(0, 0, 0);
  } else {
    modelSize = box.getSize(new THREE.Vector3()).length() || 1;
    box.getCenter(modelCenter);
  }
  applyCameraPreset();
}

async function applyModelSlotMaterials(): Promise<void> {
  const slots = props.modelMaterialSlots;
  if (!slots?.length || !loadedRoot) return;

  const maxAniso = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  const { bySlotName, built } = await fetchSlotMaterials(slots, texLoader, maxAniso);
  if (!loadedRoot) {
    for (const bm of built) { bm.material.dispose(); bm.textures.forEach((t) => t.dispose()); }
    return;
  }
  paintModelMaterialSlots(loadedRoot, slots, bySlotName);
  builtMaterials = builtMaterials.concat(built);
}

async function loadGlb(url: string): Promise<void> {
  if (!scene || !transformGroup || !glbOrient || !unitScaleGroup) return;
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  clearLoaded();
  loadedRoot = gltf.scene;
  syncUnitScale();
  syncTransformFromProps();
  unitScaleGroup.add(loadedRoot);
  await applyModelSlotMaterials();
  frameLoaded();
  syncGizmo();
}

async function loadContent(): Promise<void> {
  const token = ++loadToken;
  try {
    await loadGlb(props.url);
    if (token !== loadToken) return;
  } catch {
    /* keep whatever is currently shown */
  }
}

function resize(): void {
  const el = wrapRef.value;
  if (!el || !renderer || !camera) return;
  const size = readContainerCssSize(el);
  if (!size) return;
  const { width, height } = size;
  if (width === lastCssW && height === lastCssH) return;
  lastCssW = width;
  lastCssH = height;
  renderer.setPixelRatio(threePixelRatio());
  renderer.setSize(width, height, true);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function tick(): void {
  rafId = requestAnimationFrame(tick);
  controls?.update();
  renderer?.render(scene!, camera!);
}

onMounted(() => {
  const el = wrapRef.value;
  if (!el) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(threePixelRatio());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  el.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(props.lightBackground ? 0xe8eaed : 0x1a1a1f);

  transformGroup = new THREE.Group();
  glbOrient = new THREE.Group();
  glbOrient.rotation.x = Math.PI / 2;
  unitScaleGroup = new THREE.Group();
  glbOrient.add(unitScaleGroup);
  transformGroup.add(glbOrient);
  scene.add(transformGroup);
  syncUnitScale();

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
  camera.up.set(0, 0, 1);
  camera.position.set(2, -3, 1.5);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = props.interactive;

  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setSpace(props.gizmoSpace);
  transformControls.setMode(props.gizmoMode);
  transformControls.addEventListener('dragging-changed', onDraggingChanged);
  transformControls.addEventListener('objectChange', onGizmoObjectChange);
  transformHelper = transformControls.getHelper();
  scene.add(transformHelper);
  transformControls.detach();

  const pmrem = new THREE.PMREMGenerator(renderer);
  envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
  dirLight.position.set(4, 3, 6);
  scene.add(dirLight);

  resizeObs = new ResizeObserver(() => resize());
  resizeObs.observe(el);
  requestAnimationFrame(() => resize());
  tick();
  void loadContent();
});

const modelMaterialsKey = (): string =>
  (props.modelMaterialSlots ?? []).map((s) => `${s.name}=${s.materialId ?? ''}`).join('|');

watch(() => props.url, () => { void loadContent(); });
watch(() => modelMaterialsKey(), () => { void loadContent(); });
watch(() => props.viewPreset, applyCameraPreset);
watch(() => props.interactive, (v) => { if (controls) controls.enabled = v && !gizmoDragging; });
watch(() => [props.editable, props.gizmoMode, props.gizmoSpace], syncGizmo);
watch(() => modelTransformKey(ensureModelTransform(props.transform)), () => {
  syncTransformFromProps();
});
watch(() => props.sourceUnits, () => {
  syncUnitScale();
  frameLoaded();
});
watch(() => props.lightBackground, (v) => {
  if (scene) scene.background = new THREE.Color(v ? 0xe8eaed : 0x1a1a1f);
});

onBeforeUnmount(dispose);
</script>

<template>
  <div ref="wrapRef" class="model-viewer" :class="{ fill }" />
</template>

<style scoped>
.model-viewer {
  position: relative;
  width: 100%;
  min-height: 320px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-2, #1a1a1f);
}
.model-viewer.fill {
  min-height: 0;
  height: 100%;
  border-radius: 0;
}
.model-viewer :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
</style>
