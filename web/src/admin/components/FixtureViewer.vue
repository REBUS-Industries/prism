<script setup lang="ts">
/**
 * GLB preview for fixture library types. Loads /api/fixtures/:id/preview.glb
 * with the admin session cookie (same-origin).
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const props = defineProps<{
  url: string | null;
  /** Optional world-space datum markers (pivot points). */
  datums?: Array<{ id: string; position: { x: number; y: number; z: number }; color?: string }>;
}>();

const emit = defineEmits<{
  selectDatum: [id: string];
}>();

const wrapRef = ref<HTMLDivElement | null>(null);
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let envRT: THREE.WebGLRenderTarget | null = null;
let resizeObs: ResizeObserver | null = null;
let rafId: number | null = null;
let loadedRoot: THREE.Object3D | null = null;
const datumMeshes = new Map<string, THREE.Mesh>();

function dispose(): void {
  if (rafId != null) cancelAnimationFrame(rafId);
  resizeObs?.disconnect();
  controls?.dispose();
  if (loadedRoot) scene?.remove(loadedRoot);
  loadedRoot = null;
  for (const m of datumMeshes.values()) {
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
    scene?.remove(m);
  }
  datumMeshes.clear();
  renderer?.dispose();
  envRT?.dispose();
  renderer = scene = camera = controls = envRT = null;
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

async function loadGlb(url: string): Promise<void> {
  if (!scene) return;
  if (loadedRoot) {
    scene.remove(loadedRoot);
    loadedRoot = null;
  }
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  loadedRoot = gltf.scene;
  scene.add(loadedRoot);
  const box = new THREE.Box3().setFromObject(loadedRoot);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  controls?.target.copy(center);
  if (camera) camera.position.set(center.x + size * 0.6, center.y + size * 0.4, center.z + size * 0.8);
  syncDatums();
}

function tick(): void {
  rafId = requestAnimationFrame(tick);
  controls?.update();
  renderer?.render(scene!, camera!);
}

function onPointerDown(ev: PointerEvent): void {
  if (!camera || !wrapRef.value) return;
  const rect = wrapRef.value.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(x, y), camera);
  const hits = ray.intersectObjects([...datumMeshes.values()]);
  if (hits[0]?.object.userData.datumId) emit('selectDatum', hits[0].object.userData.datumId as string);
}

onMounted(() => {
  const el = wrapRef.value;
  if (!el) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  el.appendChild(renderer.domElement);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1f);
  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
  camera.position.set(2, 1.5, 3);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(4, 6, 3);
  scene.add(dir);

  const resize = (): void => {
    if (!el || !renderer || !camera) return;
    const w = el.clientWidth;
    const h = el.clientHeight || 320;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  resizeObs = new ResizeObserver(resize);
  resizeObs.observe(el);
  resize();
  tick();
  if (props.url) void loadGlb(props.url).catch(() => null);
});

watch(() => props.url, (u) => { if (u) void loadGlb(u).catch(() => null); });
watch(() => props.datums, syncDatums, { deep: true });

onBeforeUnmount(dispose);
</script>

<template>
  <div ref="wrapRef" class="fixture-viewer" />
</template>

<style scoped>
.fixture-viewer {
  width: 100%;
  min-height: 320px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-2, #1a1a1f);
}
</style>
