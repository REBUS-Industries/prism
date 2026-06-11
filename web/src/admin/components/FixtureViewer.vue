<script setup lang="ts">
/**
 * Fixture 3D viewer. Two render modes:
 *  - `assembly`: walk the GDTF geometry tree, load every linked model GLB and
 *    apply the composed transforms to show the FULL assembled fixture.
 *  - `url`: single GLB (legacy preview.glb) fallback.
 * The assembly is preferred whenever it yields at least one mesh.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { readContainerCssSize, threePixelRatio } from '../utils/threeResize';
import { buildFixtureAssembly, disposeAssembly, type MotionNode } from '../utils/fixtureAssembly';
import { fixturesApi, type FixturePart, type FixtureModel, type MotionAxis } from '../../shared/api';

interface AssemblyProp {
  fixtureId: string;
  parts: FixturePart[];
  models: FixtureModel[];
  /**
   * Motion rig entries used to target pan/tilt rotations at the correct
   * geometry nodes (Yoke for pan, Head for tilt) rather than wrapping the
   * whole assembly.
   */
  motionAxes?: MotionAxis[];
}

const props = withDefaults(defineProps<{
  url?: string | null;
  /** Full geometry tree + models for assembled rendering. */
  assembly?: AssemblyProp | null;
  /** Optional world-space datum markers (pivot points). */
  datums?: Array<{ id: string; position: { x: number; y: number; z: number }; color?: string }>;
  viewPreset?: 'top' | 'front' | 'side' | 'iso';
  panDeg?: number;
  tiltDeg?: number;
  dimmer?: number;
  showBeam?: boolean;
  /** When false, orbit controls are disabled (quad ortho views). */
  interactive?: boolean;
  lightBackground?: boolean;
  /** Fill parent height (quad/debug panels); omit min-height when true. */
  fill?: boolean;
}>(), {
  url: null,
  assembly: null,
  viewPreset: 'iso',
  panDeg: 0,
  tiltDeg: 0,
  dimmer: 1,
  showBeam: false,
  interactive: true,
  lightBackground: false,
  fill: false,
});

const emit = defineEmits<{
  selectDatum: [id: string];
  resetView: [];
}>();

const wrapRef = ref<HTMLDivElement | null>(null);
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let envRT: THREE.WebGLRenderTarget | null = null;
let resizeObs: ResizeObserver | null = null;
let rafId: number | null = null;
let panGroup: THREE.Group | null = null;
let tiltGroup: THREE.Group | null = null;
/** Pan node from the assembly motion rig (Yoke). Overrides panGroup when set. */
let panNode: MotionNode | null = null;
/** Tilt node from the assembly motion rig (Head). Overrides tiltGroup when set. */
let tiltNode: MotionNode | null = null;
let loadedRoot: THREE.Object3D | null = null;
let dirLight: THREE.DirectionalLight | null = null;
let beamMesh: THREE.Mesh | null = null;
let modelCenter = new THREE.Vector3();
let modelSize = 1;
let lastCssW = 0;
let lastCssH = 0;
let loadToken = 0;
const datumMeshes = new Map<string, THREE.Mesh>();

function clearLoaded(): void {
  // removeFromParent() works whether the root was added to scene or tiltGroup.
  loadedRoot?.removeFromParent();
  if (loadedRoot) disposeAssembly(loadedRoot);
  loadedRoot = null;
  panNode = null;
  tiltNode = null;
}

function dispose(): void {
  if (rafId != null) cancelAnimationFrame(rafId);
  resizeObs?.disconnect();
  controls?.dispose();
  clearLoaded();
  if (beamMesh) {
    beamMesh.geometry.dispose();
    (beamMesh.material as THREE.Material).dispose();
    scene?.remove(beamMesh);
    beamMesh = null;
  }
  for (const m of datumMeshes.values()) {
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
    scene?.remove(m);
  }
  datumMeshes.clear();
  const dom = renderer?.domElement;
  renderer?.dispose();
  if (dom && wrapRef.value?.contains(dom)) wrapRef.value.removeChild(dom);
  envRT?.dispose();
  renderer = scene = camera = controls = envRT = panGroup = tiltGroup = dirLight = null;
}

function applyCameraPreset(): void {
  if (!camera || !controls) return;
  const s = modelSize;
  const c = modelCenter;
  const presets: Record<string, [number, number, number]> = {
    top: [c.x, c.y + s * 1.2, c.z + 0.001],
    front: [c.x, c.y + s * 0.15, c.z + s * 1.1],
    side: [c.x + s * 1.1, c.y + s * 0.15, c.z],
    iso: [c.x + s * 0.6, c.y + s * 0.4, c.z + s * 0.8],
  };
  const pos = presets[props.viewPreset] ?? presets.iso;
  camera.position.set(pos[0], pos[1], pos[2]);
  controls.target.copy(c);
  controls.update();
}

function syncMotion(): void {
  const panRad = (props.panDeg * Math.PI) / 180;
  const tiltRad = (props.tiltDeg * Math.PI) / 180;

  if (panNode) {
    // Rotate the Yoke (or equivalent pan geometry) around GDTF Z (vertical).
    // Base stays static; Head and Beam follow as children.
    panNode.obj.quaternion
      .copy(panNode.restQuaternion)
      .multiply(new THREE.Quaternion().setFromAxisAngle(panNode.axis, panRad));
  } else if (panGroup) {
    panGroup.rotation.y = panRad;
  }

  if (tiltNode) {
    // Rotate the Head (or equivalent tilt geometry) around GDTF X (horizontal).
    // The axis automatically tracks the current pan because Head is a Three.js
    // child of the Yoke group whose rotation is already applied.
    tiltNode.obj.quaternion
      .copy(tiltNode.restQuaternion)
      .multiply(new THREE.Quaternion().setFromAxisAngle(tiltNode.axis, tiltRad));
  } else if (tiltGroup) {
    tiltGroup.rotation.x = tiltRad;
  }
}

function syncDimmer(): void {
  if (dirLight) dirLight.intensity = 0.2 + props.dimmer * 1.2;
}

function syncBeam(): void {
  if (!scene) return;
  if (!props.showBeam) {
    if (beamMesh) {
      scene.remove(beamMesh);
      beamMesh.geometry.dispose();
      (beamMesh.material as THREE.Material).dispose();
      beamMesh = null;
    }
    return;
  }
  if (!beamMesh) {
    const geo = new THREE.ConeGeometry(0.08, 0.6, 16, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff6600,
      transparent: true,
      opacity: 0.35,
      wireframe: true,
      side: THREE.DoubleSide,
    });
    beamMesh = new THREE.Mesh(geo, mat);
    beamMesh.rotation.x = Math.PI;
    scene.add(beamMesh);
  }
  const s = modelSize;
  beamMesh.position.set(modelCenter.x, modelCenter.y + s * 0.2, modelCenter.z);
  beamMesh.scale.setScalar(Math.max(s * 0.5, 0.3));
}

function syncDatums(): void {
  if (!scene) return;
  const want = new Set((props.datums ?? []).map((d) => d.id));
  for (const [id, mesh] of [...datumMeshes.entries()]) {
    if (!want.has(id)) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      datumMeshes.delete(id);
    }
  }
  for (const d of props.datums ?? []) {
    let mesh = datumMeshes.get(d.id);
    if (!mesh) {
      const geo = new THREE.SphereGeometry(0.04, 16, 12);
      const mat = new THREE.MeshStandardMaterial({ color: d.color ?? '#ff6600', emissive: '#331100' });
      mesh = new THREE.Mesh(geo, mat);
      mesh.userData.datumId = d.id;
      datumMeshes.set(d.id, mesh);
      scene.add(mesh);
    }
    mesh.position.set(d.position.x, d.position.y, d.position.z);
  }
}

function frameLoaded(precomputedBox?: THREE.Box3): void {
  if (!loadedRoot) return;
  // Prefer a pre-computed box (from buildFixtureAssembly, computed while root
  // had no parent) to avoid stale parent-matrixWorld reads that occur when
  // Box3.setFromObject runs after the root is inserted into the scene graph.
  const box = precomputedBox ?? new THREE.Box3().setFromObject(loadedRoot);
  if (box.isEmpty()) {
    modelSize = 1;
    modelCenter.set(0, 0, 0);
  } else {
    modelSize = box.getSize(new THREE.Vector3()).length() || 1;
    box.getCenter(modelCenter);
  }
  applyCameraPreset();
  syncMotion();
  syncBeam();
  syncDatums();
}

async function loadGlb(url: string): Promise<boolean> {
  if (!scene || !tiltGroup) return false;
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  clearLoaded();
  loadedRoot = gltf.scene;
  tiltGroup.add(loadedRoot);
  frameLoaded();
  return true;
}

async function loadAssembly(a: AssemblyProp): Promise<boolean> {
  if (!scene || !a.parts?.length) return false;
  const { root, meshCount, box, panNode: pn, tiltNode: tn } = await buildFixtureAssembly({
    parts: a.parts,
    models: a.models ?? [],
    motionAxes: a.motionAxes ?? [],
    resolveUrl: (mediaId) => fixturesApi.mediaUrl(a.fixtureId, mediaId),
  });
  if (meshCount === 0) {
    disposeAssembly(root);
    return false;
  }
  clearLoaded();
  loadedRoot = root;
  panNode = pn ?? null;
  tiltNode = tn ?? null;
  // Add directly to scene so Base stays static and only Yoke / Head rotate.
  // The legacy panGroup/tiltGroup remain for single-GLB mode.
  scene.add(root);
  frameLoaded(box);
  return true;
}

async function loadContent(): Promise<void> {
  const token = ++loadToken;
  try {
    if (props.assembly && props.assembly.parts?.length) {
      const ok = await loadAssembly(props.assembly);
      if (token !== loadToken) return;
      if (ok) return;
    }
    if (props.url) {
      await loadGlb(props.url);
    }
  } catch {
    /* keep whatever is currently shown */
  }
}

function resetView(): void {
  applyCameraPreset();
  emit('resetView');
}

function tick(): void {
  rafId = requestAnimationFrame(tick);
  controls?.update();
  renderer?.render(scene!, camera!);
}

function onPointerDown(ev: PointerEvent): void {
  if (!props.interactive || !camera || !wrapRef.value) return;
  const rect = wrapRef.value.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(x, y), camera);
  const hits = ray.intersectObjects([...datumMeshes.values()]);
  if (hits[0]?.object.userData.datumId) emit('selectDatum', hits[0].object.userData.datumId as string);
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

onMounted(() => {
  const el = wrapRef.value;
  if (!el) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(threePixelRatio());
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  el.appendChild(renderer.domElement);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(props.lightBackground ? 0xe8eaed : 0x1a1a1f);

  panGroup = new THREE.Group();
  tiltGroup = new THREE.Group();
  panGroup.add(tiltGroup);
  scene.add(panGroup);

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
  camera.position.set(2, 1.5, 3);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = props.interactive;

  const pmrem = new THREE.PMREMGenerator(renderer);
  envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
  dirLight.position.set(4, 6, 3);
  scene.add(dirLight);

  resizeObs = new ResizeObserver(() => resize());
  resizeObs.observe(el);
  requestAnimationFrame(() => resize());
  syncDimmer();
  tick();
  void loadContent();
});

const assemblyKey = (): string => {
  const a = props.assembly;
  if (!a) return '';
  return `${a.fixtureId}:${a.parts?.length ?? 0}:${a.models?.length ?? 0}`;
};

watch(() => [props.url, assemblyKey()], () => { void loadContent(); });
watch(() => props.datums, syncDatums, { deep: true });
watch(() => props.viewPreset, applyCameraPreset);
watch(() => [props.panDeg, props.tiltDeg], syncMotion);
watch(() => props.dimmer, syncDimmer);
watch(() => props.showBeam, syncBeam);
watch(() => props.interactive, (v) => { if (controls) controls.enabled = v; });
watch(() => props.lightBackground, (v) => {
  if (scene) scene.background = new THREE.Color(v ? 0xe8eaed : 0x1a1a1f);
});

defineExpose({ resetView });

onBeforeUnmount(dispose);
</script>

<template>
  <div ref="wrapRef" class="fixture-viewer" :class="{ fill }" />
</template>

<style scoped>
.fixture-viewer {
  position: relative;
  width: 100%;
  min-height: 320px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-2, #1a1a1f);
}
.fixture-viewer.fill {
  min-height: 0;
  height: 100%;
  border-radius: 0;
}
.fixture-viewer :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
  max-width: 100%;
  max-height: 100%;
}
</style>
