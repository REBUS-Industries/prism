<script setup lang="ts">
/**
 * Fixture 3D viewer. Two render modes:
 *  - `assembly`: walk the GDTF geometry tree, load every linked model GLB and
 *    apply the composed transforms to show the FULL assembled fixture.
 *  - `url`: single GLB (legacy preview.glb) fallback.
 * Z-up authoring space (camera.up = Z; assembly stays in GDTF Z-up).
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { readContainerCssSize, threePixelRatio } from '../utils/threeResize';
import { buildFixtureAssembly, disposeAssembly, findGeometryReferenceEmissionNode, type MotionNode } from '../utils/fixtureAssembly';
import type { ClampPlacement } from '../utils/fixturePlacement';
import { buildFixturePbrMaterial, type BuiltMaterial } from '../utils/fixturePbrMaterial';
import { fetchSlotMaterials, paintModelMaterialSlots } from '../utils/modelMaterialSlots';
import { fixturesApi, materialsApi, type FixturePart, type FixtureModel, type ModelMaterialSlot, type ModelTransform, type MotionAxis, type Vec3 } from '../../shared/api';

/** Gizmo edit emitted to the parent (GDTF local space: position metres, rotation degrees). */
export interface PartTransformEdit {
  partId: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

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
  /** DMX mode root geometry to render (multi-mode fixtures). */
  selectedModeGeometryId?: string | null;
  /** Metres to lower fixture body while CLAMP/ORIGIN stay at the hang point. */
  fixtureZOffsetM?: number;
  /** REBUS clamp Z mirror + Z rotation through fixture origin. */
  clampPlacement?: ClampPlacement;
  /** Model Library preview GLB for the REBUS clamp (overrides fixture upload). */
  clampModelUrl?: string;
  /** Model Library material slots for the linked clamp (when clampModelUrl is set). */
  clampMaterialSlots?: ModelMaterialSlot[];
  /** Model Library root transform for the linked clamp (metres, degrees). */
  clampModelTransform?: ModelTransform | null;
  /** Vertex units of the library clamp GLB. */
  clampSourceUnits?: string | null;
}

const props = withDefaults(defineProps<{
  url?: string | null;
  /** Full geometry tree + models for assembled rendering. */
  assembly?: AssemblyProp | null;
  /**
   * Model-library material slots for `url` mode only. When provided, after the
   * single GLB loads each slot with a resolved `materialId` is fetched, built
   * into a THREE material and painted onto the meshes whose material/mesh name
   * matches the slot name (or onto every mesh when there is a single slot).
   * Ignored in assembly mode so fixture rendering is unaffected.
   */
  modelMaterialSlots?: ModelMaterialSlot[] | null;
  /** Optional world-space datum markers (pivot points). */
  datums?: Array<{ id: string; position: { x: number; y: number; z: number }; color?: string }>;
  viewPreset?: 'top' | 'front' | 'side' | 'iso';
  panDeg?: number;
  tiltDeg?: number;
  /** Per-axis motion angles (motionAxisId → degrees). When set, drives every
   *  motion axis individually (supports fixtures with multiple pan/tilt axes)
   *  and takes precedence over panDeg/tiltDeg. */
  motionAngles?: Record<string, number>;
  dimmer?: number;
  showBeam?: boolean;
  /**
   * Beam-sim cones — one per fixture beam, each attached at its own part so
   * multi-beam (pixel) fixtures array correctly. Each cone starts at the lens
   * diameter and opens to the beam angle (min + max zoom cones when a zoom range
   * is present). lensDiameter is metres; angles are degrees.
   */
  beams?: Array<{ parentPartId?: string | null; lensDiameter?: number; beamAngle?: number; zoomMin?: number; zoomMax?: number }> | null;
  /** When false, orbit controls are disabled (quad ortho views). */
  interactive?: boolean;
  lightBackground?: boolean;
  /** Fill parent height (quad/debug panels); omit min-height when true. */
  fill?: boolean;
  /** Bump to force assembly reload after in-place geometry edits. */
  assemblyRevision?: number;
  /** Enable click-to-select picking + a transform gizmo on the selected part. */
  editable?: boolean;
  /** Part the gizmo attaches to (assembly mode only). */
  selectedPartId?: string | null;
  /** Active gizmo transform mode. */
  gizmoMode?: 'translate' | 'rotate' | 'scale';
  /** Gizmo coordinate space. 'local' aligns with GDTF axes (matches panel). */
  gizmoSpace?: 'world' | 'local';
}>(), {
  url: null,
  assembly: null,
  modelMaterialSlots: null,
  viewPreset: 'iso',
  panDeg: 0,
  tiltDeg: 0,
  dimmer: 1,
  showBeam: false,
  interactive: true,
  lightBackground: false,
  fill: false,
  assemblyRevision: 0,
  editable: false,
  selectedPartId: null,
  gizmoMode: 'translate',
  gizmoSpace: 'local',
});

const emit = defineEmits<{
  selectDatum: [id: string];
  selectPart: [partId: string];
  transformPart: [edit: PartTransformEdit];
  resetView: [];
}>();

const wrapRef = ref<HTMLDivElement | null>(null);
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let transformControls: TransformControls | null = null;
let transformHelper: THREE.Object3D | null = null;
/** partId → group carrying the GDTF local transform (for gizmo + picking). */
let partGroups = new Map<string, THREE.Group>();
let envRT: THREE.WebGLRenderTarget | null = null;
let resizeObs: ResizeObserver | null = null;
let rafId: number | null = null;
let panGroup: THREE.Group | null = null;
let tiltGroup: THREE.Group | null = null;
/** +90° X wrapper for legacy single-GLB url mode (Y-up glTF → Z-up viewer). */
let glbOrient: THREE.Group | null = null;
/** Pan node from the assembly motion rig (Yoke). Overrides panGroup when set. */
let panNode: MotionNode | null = null;
/** Tilt node from the assembly motion rig (Head). Overrides tiltGroup when set. */
let tiltNode: MotionNode | null = null;
/** All motion axes from the current assembly (for per-axis motion control). */
let assemblyMotionAxes: MotionAxis[] = [];
/** Parts from the last loaded assembly — used for beam emission attach. */
let assemblyParts: FixturePart[] = [];
/** Rest quaternion per controlled part group, captured at load for per-axis motion. */
const motionRest = new Map<string, THREE.Quaternion>();
/** BEAM part group from assembly — preferred parent for beam wireframe. */
let beamPartGroup: THREE.Object3D | null = null;
let loadedRoot: THREE.Object3D | null = null;
let dirLight: THREE.DirectionalLight | null = null;
let beamGroups: THREE.Group[] = [];

function disposeBeam(): void {
  for (const g of beamGroups) {
    g.removeFromParent();
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
  }
  beamGroups = [];
}
/** Cone height — tip translated to local origin in syncBeam(). */
const BEAM_CONE_HEIGHT = 0.6;
let modelCenter = new THREE.Vector3();
let modelSize = 1;
let lastCssW = 0;
let lastCssH = 0;
let loadToken = 0;
const datumMeshes = new Map<string, THREE.Mesh>();
const texLoader = new THREE.TextureLoader();
/** REBUS materials built for the current assembly — disposed on reload. */
let builtMaterials: BuiltMaterial[] = [];

function disposeBuiltMaterials(): void {
  for (const bm of builtMaterials) {
    bm.material.dispose();
    for (const t of bm.textures) t.dispose();
  }
  builtMaterials = [];
}

function clearLoaded(): void {
  // Detach the gizmo before disposing the groups it may be attached to.
  transformControls?.detach();
  assemblyParts = [];
  partGroups = new Map();
  disposeBuiltMaterials();
  // Detach beams before disposing assembly nodes they may be parented to.
  disposeBeam();
  // removeFromParent() works whether the root was added to scene or tiltGroup.
  loadedRoot?.removeFromParent();
  if (loadedRoot) disposeAssembly(loadedRoot);
  loadedRoot = null;
  panNode = null;
  tiltNode = null;
  assemblyMotionAxes = [];
  motionRest.clear();
  beamPartGroup = null;
}

/** Parent for beam wireframe — inherits pan/tilt via Three.js hierarchy. */
function beamParent(): THREE.Object3D | null {
  if (beamPartGroup) return beamPartGroup;
  if (tiltNode) return tiltNode.obj;
  return tiltGroup;
}

function dispose(): void {
  if (rafId != null) cancelAnimationFrame(rafId);
  resizeObs?.disconnect();
  controls?.dispose();
  if (transformControls) {
    transformControls.removeEventListener('objectChange', onGizmoObjectChange);
    transformControls.detach();
    transformHelper?.removeFromParent();
    transformControls.dispose();
    transformControls = null;
    transformHelper = null;
  }
  clearLoaded();
  disposeBeam();
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
  renderer = scene = camera = controls = envRT = panGroup = tiltGroup = glbOrient = dirLight = null;
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

function syncMotion(): void {
  // Per-axis mode: drive every motion axis individually (multiple pan/tilt).
  const angles = props.motionAngles;
  if (angles && assemblyMotionAxes.length) {
    for (const ax of assemblyMotionAxes) {
      const partId = ax.controlledPartId;
      if (!partId) continue;
      const g = partGroups.get(partId);
      const rest = motionRest.get(partId);
      if (!g || !rest) continue;
      const rad = ((angles[ax.motionAxisId] ?? 0) * Math.PI) / 180;
      // Derive the rotation axis from the axis TYPE (matches the assembly's
      // motion-node convention) — the parsed axisVector is unreliable because it
      // keys off the geometry name (e.g. JDC's head isn't named "tilt").
      //   PAN → GDTF Z (0,0,1 vertical) · TILT → GDTF X (1,0,0 horizontal)
      let axis: THREE.Vector3;
      if (ax.axisType === 'PAN') axis = new THREE.Vector3(0, 0, 1);
      else if (ax.axisType === 'TILT') axis = new THREE.Vector3(1, 0, 0);
      else {
        axis = new THREE.Vector3(ax.axisVector.x, ax.axisVector.y, ax.axisVector.z);
        if (axis.lengthSq() < 1e-9) axis.set(0, 0, 1);
      }
      axis.normalize();
      g.quaternion.copy(rest).multiply(new THREE.Quaternion().setFromAxisAngle(axis, rad));
    }
    return;
  }

  const panRad = (props.panDeg * Math.PI) / 180;
  const tiltRad = (props.tiltDeg * Math.PI) / 180;

  if (panNode) {
    // Rotate the Yoke (or equivalent pan geometry) around GDTF Z (vertical).
    // Base stays static; Head and Beam follow as children.
    panNode.obj.quaternion
      .copy(panNode.restQuaternion)
      .multiply(new THREE.Quaternion().setFromAxisAngle(panNode.axis, panRad));
  } else if (panGroup) {
    panGroup.rotation.z = panRad;
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

/** Attach / detach the transform gizmo based on editable + selectedPartId. */
function syncGizmo(): void {
  if (!transformControls) return;
  const grp = props.editable && props.selectedPartId
    ? partGroups.get(props.selectedPartId)
    : undefined;
  if (grp) {
    transformControls.setMode(props.gizmoMode);
    transformControls.setSpace(props.gizmoSpace);
    transformControls.attach(grp);
  } else {
    transformControls.detach();
  }
}

/** Read the gizmo'd group's local TRS (GDTF space) and emit it to the parent. */
function onGizmoObjectChange(): void {
  const obj = transformControls?.object as THREE.Object3D | undefined;
  const id = props.selectedPartId;
  if (!obj || !id) return;
  const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ');
  emit('transformPart', {
    partId: id,
    position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    rotation: {
      x: THREE.MathUtils.radToDeg(e.x),
      y: THREE.MathUtils.radToDeg(e.y),
      z: THREE.MathUtils.radToDeg(e.z),
    },
    scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
  });
}

/** Open frustum (truncated cone) wireframe: top radius at the lens, opening to
 *  bottom radius over BEAM_CONE_HEIGHT. Top sits on the attach origin. */
function makeBeamFrustum(topR: number, bottomR: number, opacity: number): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(topR, bottomR, BEAM_CONE_HEIGHT, 24, 1, true);
  geo.translate(0, -BEAM_CONE_HEIGHT / 2, 0);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff6600, transparent: true, opacity, wireframe: true, side: THREE.FrontSide,
  });
  return new THREE.Mesh(geo, mat);
}

function syncBeam(): void {
  if (!scene) return;
  disposeBeam();
  if (!props.showBeam) return;

  const fallback = beamParent();
  const specs = props.beams ?? [];
  for (const spec of specs) {
    const hostPartId = spec.parentPartId ?? null;
    let attach: THREE.Object3D | null = hostPartId ? partGroups.get(hostPartId) ?? null : null;
    if (attach && hostPartId) {
      attach = findGeometryReferenceEmissionNode(hostPartId, assemblyParts, attach);
    }
    attach = attach ?? fallback;
    if (!attach) continue;

    const group = new THREE.Group();
    const lensR = Math.max((spec.lensDiameter ?? 0) / 2, 0.01);
    const bottomFor = (deg: number): number =>
      lensR + BEAM_CONE_HEIGHT * Math.tan((Math.max(deg, 1) / 2) * Math.PI / 180);
    const angle = spec.beamAngle ?? 20;
    group.add(makeBeamFrustum(lensR, bottomFor(angle), 0.32));

    group.position.set(0, 0, 0);
    if (hostPartId || tiltNode || beamPartGroup) {
      // GDTF Z-up: beam opens along −Z; top (lens) at the emission origin.
      group.rotation.set(Math.PI / 2, 0, 0);
      group.scale.setScalar(1);
    } else {
      group.rotation.set(0, 0, 0);
      group.scale.setScalar(Math.max(modelSize * 0.5, 0.3));
    }
    attach.add(group);
    beamGroups.push(group);
  }
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
  if (!scene || !glbOrient) return false;
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  clearLoaded();
  loadedRoot = gltf.scene;
  glbOrient.add(loadedRoot);
  await applyModelSlotMaterials();
  frameLoaded();
  return true;
}

/**
 * Paint model-library slot materials onto the freshly loaded single GLB.
 * Slot → mesh matching: a single slot paints every mesh; otherwise a slot is
 * applied to meshes whose `material.name` (or, failing that, `mesh.name`)
 * equals the slot name — the same `materials[].name` the importer recorded.
 */
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

async function loadAssembly(a: AssemblyProp): Promise<boolean> {
  if (!scene || !a.parts?.length) return false;

  // Build the REBUS materials assigned to parts (by resolved materialId) so the
  // assembly can paint each part's mesh with its material.
  const newBuilt: BuiltMaterial[] = [];
  const materialsById = new Map<string, THREE.Material>();
  const matIds = [...new Set(a.parts.map((p) => p.materialId).filter((id): id is string => !!id))];
  const maxAniso = renderer?.capabilities.getMaxAnisotropy() ?? 1;
  await Promise.all(matIds.map(async (id) => {
    try {
      const detail = await materialsApi.get(id);
      const bm = buildFixturePbrMaterial(detail, texLoader, maxAniso);
      newBuilt.push(bm);
      materialsById.set(id, bm.material);
    } catch {
      // Material may have been deleted; skip — the mesh keeps its GLB material.
    }
  }));

  let clampSlotMaterialsByName: Map<string, THREE.Material> | undefined;
  if (a.clampModelUrl && a.clampMaterialSlots?.length) {
    const { bySlotName, built } = await fetchSlotMaterials(a.clampMaterialSlots, texLoader, maxAniso);
    if (bySlotName.size) {
      clampSlotMaterialsByName = bySlotName;
      newBuilt.push(...built);
    }
  }

  const { root, meshCount, box, panNode: pn, tiltNode: tn, beamPart, partGroups: pg } = await buildFixtureAssembly({
    parts: a.parts,
    models: a.models ?? [],
    motionAxes: a.motionAxes ?? [],
    selectedModeGeometryId: a.selectedModeGeometryId ?? null,
    fixtureZOffsetM: a.fixtureZOffsetM ?? 0,
    clampPlacement: a.clampPlacement,
    clampModelUrl: a.clampModelUrl,
    clampMaterialSlots: a.clampMaterialSlots,
    clampModelTransform: a.clampModelTransform,
    clampSourceUnits: a.clampSourceUnits,
    clampSlotMaterialsByName,
    materialsById,
    resolveUrl: (mediaId) => fixturesApi.mediaUrl(a.fixtureId, mediaId),
  });
  if (meshCount === 0) {
    disposeAssembly(root);
    for (const bm of newBuilt) { bm.material.dispose(); bm.textures.forEach((t) => t.dispose()); }
    return false;
  }
  clearLoaded();
  builtMaterials = newBuilt;
  loadedRoot = root;
  panNode = pn ?? null;
  tiltNode = tn ?? null;
  beamPartGroup = beamPart ?? null;
  assemblyParts = a.parts;
  partGroups = pg;
  // Capture rest quaternions for per-axis motion control.
  assemblyMotionAxes = a.motionAxes ?? [];
  motionRest.clear();
  for (const ax of assemblyMotionAxes) {
    if (!ax.controlledPartId) continue;
    const g = partGroups.get(ax.controlledPartId);
    if (g) motionRest.set(ax.controlledPartId, g.quaternion.clone());
  }
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
      if (ok) {
        syncGizmo();
        return;
      }
    }
    if (props.url) {
      await loadGlb(props.url);
    }
    syncGizmo();
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

/** Walk up the scene graph to the nearest ancestor tagged with a partId. */
function resolvePartId(obj: THREE.Object3D | null): string | null {
  let o: THREE.Object3D | null = obj;
  while (o) {
    const id = (o.userData as { partId?: unknown }).partId;
    if (typeof id === 'string' && id) return id;
    o = o.parent;
  }
  return null;
}

function onPointerDown(ev: PointerEvent): void {
  if (!props.interactive || !camera || !wrapRef.value) return;
  // Don't hijack clicks meant for the transform gizmo handles.
  if (transformControls && (transformControls.axis || transformControls.dragging)) return;
  const rect = wrapRef.value.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(x, y), camera);

  const datumHits = ray.intersectObjects([...datumMeshes.values()]);
  if (datumHits[0]?.object.userData.datumId) {
    emit('selectDatum', datumHits[0].object.userData.datumId as string);
    return;
  }

  if (props.editable && loadedRoot) {
    const hits = ray.intersectObject(loadedRoot, true);
    for (const h of hits) {
      const id = resolvePartId(h.object);
      if (id) { emit('selectPart', id); return; }
    }
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

onMounted(() => {
  const el = wrapRef.value;
  if (!el) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(threePixelRatio());
  // ACES tone mapping so PBR roughness/metallic + IBL highlights read correctly
  // (matches the materials editor preview); without it metallic looks flat.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
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
  glbOrient = new THREE.Group();
  glbOrient.rotation.x = Math.PI / 2;
  panGroup.add(tiltGroup);
  tiltGroup.add(glbOrient);
  scene.add(panGroup);

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
  camera.up.set(0, 0, 1);
  camera.position.set(2, -3, 1.5);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = props.interactive;

  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setSpace(props.gizmoSpace);
  transformControls.setMode(props.gizmoMode);
  // Pause orbit while dragging a handle so the camera doesn't fight the gizmo.
  transformControls.addEventListener('dragging-changed', (e) => {
    if (controls) controls.enabled = props.interactive && !(e as unknown as { value: boolean }).value;
  });
  transformControls.addEventListener('objectChange', onGizmoObjectChange);
  transformHelper = transformControls.getHelper();
  scene.add(transformHelper);
  transformControls.detach();

  const pmrem = new THREE.PMREMGenerator(renderer);
  envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
  dirLight.position.set(4, 3, 6);
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
  const mats = a.parts?.map((p) => `${p.partId}=${p.materialId ?? ''}`).join('|') ?? '';
  const clamp = a.clampPlacement;
  const clampKey = clamp ? `${clamp.mirrorZ ? 1 : 0}:${clamp.rotateZDeg}` : '0:0';
  const clampSlots = (a.clampMaterialSlots ?? []).map((s) => `${s.name}=${s.materialId ?? ''}`).join('|');
  const clampXform = a.clampModelTransform
    ? `${a.clampModelTransform.position.x},${a.clampModelTransform.position.y},${a.clampModelTransform.position.z}|${a.clampModelTransform.rotation.x},${a.clampModelTransform.rotation.y},${a.clampModelTransform.rotation.z}|${a.clampModelTransform.scale.x},${a.clampModelTransform.scale.y},${a.clampModelTransform.scale.z}`
    : '';
  return `${a.fixtureId}:${a.parts?.length ?? 0}:${a.models?.length ?? 0}:${a.selectedModeGeometryId ?? ''}:${a.fixtureZOffsetM ?? 0}:${clampKey}:${a.clampModelUrl ?? ''}:${clampSlots}:${clampXform}:${a.clampSourceUnits ?? ''}:${mats}`;
};

const modelMaterialsKey = (): string =>
  (props.modelMaterialSlots ?? []).map((s) => `${s.name}=${s.materialId ?? ''}`).join('|');

watch(() => [props.url, assemblyKey(), modelMaterialsKey(), props.assemblyRevision], () => { void loadContent(); });
watch(() => props.datums, syncDatums, { deep: true });
watch(() => props.viewPreset, applyCameraPreset);
watch(() => [props.panDeg, props.tiltDeg], syncMotion);
watch(() => props.motionAngles, syncMotion, { deep: true });
watch(() => props.dimmer, syncDimmer);
watch(() => props.showBeam, syncBeam);
watch(() => props.beams, syncBeam, { deep: true });
watch(() => props.interactive, (v) => { if (controls) controls.enabled = v; });
watch(() => [props.editable, props.selectedPartId, props.gizmoMode, props.gizmoSpace], syncGizmo);
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
