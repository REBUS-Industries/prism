"""Assimp scene load -> OBJ+MTL+textures.zip emission.

Orchestrates layers + materials + packaging for the FastAPI `/v1/preconvert`
endpoint.  All scene access happens inside the ``pyassimp.load`` context
manager so the underlying C-side memory is released even if a downstream
writer raises.
"""

from __future__ import annotations

import logging
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger("prism-assimp.converter")


@dataclass(frozen=True)
class PreconvertOptions:
    flatten_hierarchy: bool = False
    target_unit: str = "m"


@dataclass
class PreconvertResult:
    obj_path: Path
    mtl_path: Optional[Path]
    zip_path: Path
    stats: Dict[str, Any] = field(default_factory=dict)
    manifest: Dict[str, Any] = field(default_factory=dict)


# Source files are interpreted in their authored unit (we don't attempt to
# detect it -- glTF says metres, FBX says centimetres-by-default-but-actually-
# whatever-the-author-wanted, OBJ has no unit at all).  ``target_unit``
# multiplies vertex positions on the way out so downstream consumers get a
# consistent scale.  The agent imports OBJ in metres regardless.
_UNIT_TO_METRES = {
    "mm": 0.001,
    "cm": 0.01,
    "m": 1.0,
    "inch": 0.0254,
    "ft": 0.3048,
}


def _expand_bundle(bundle_path: Optional[Path], work_dir: Path) -> Optional[Path]:
    if bundle_path is None:
        return None
    bundle_dir = work_dir / "bundle"
    bundle_dir.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(bundle_path) as zf:
            for member in zf.namelist():
                # zipfile prevents path traversal in 3.6+ but we belt-and-brace.
                target = (bundle_dir / member).resolve()
                if bundle_dir.resolve() not in target.parents and target != bundle_dir.resolve():
                    logger.warning("skipping suspicious zip member %r", member)
                    continue
            zf.extractall(bundle_dir)
    except zipfile.BadZipFile:
        logger.warning("bundle %s is not a valid zip; ignoring", bundle_path)
        return None
    logger.info("expanded bundle into %s", bundle_dir)
    return bundle_dir


def _postprocess_flags(options: PreconvertOptions) -> int:
    """Build the bitwise-or of post-processing steps we want Assimp to run.
    Imported lazily so the module is importable even when ``pyassimp`` /
    ``libassimp`` aren't installed (handy for unit tests on the API
    surface).

    NOTE on ``aiProcess_PreTransformVertices``: pyassimp 4.1.4 (the only
    PyPI release of the official bindings) has a long-standing
    memory-layout bug where ``node.transformation`` is unreliable -- the
    underlying numpy view of the C ``aiMatrix4x4`` struct comes back
    shifted by a float, so even identity matrices look corrupt and
    rotations multiply vertices by a near-degenerate matrix.  We sidestep
    the problem by asking Assimp to bake every node's world transform
    into the mesh vertices themselves and to flatten the node hierarchy
    on its way out, leaving us with identity transforms everywhere.  The
    cost is that Phase-1 layer preservation degrades to "one OBJ group
    per scene mesh" (we lose the original Maya/Blender folder names);
    Phase 2 will ditch pyassimp 4.1.4 for a fork that decodes matrices
    correctly and re-enable the per-node walk.
    """
    from pyassimp import postprocess  # type: ignore

    # NOTE on ``aiProcess_ValidateDataStructure``: deliberately omitted.
    # The validator is overly strict for real-world exporter output -- in
    # particular Rhinoceros's COLLADA exporter writes multiple cameras
    # with duplicate names (`Front` / `Back` / `Left` / `Right` from the
    # default viewport set), which the validator rejects with
    # `Validation failed: aiScene::mCameras[0] has the same name as
    # aiScene::mCameras[2]` and refuses to return a scene at all.  Since
    # we re-emit everything as OBJ regardless, we don't depend on the
    # internal aiScene structure being clean; loading without validation
    # lets us recover the geometry from files that fail validator nits.
    flags = (
        postprocess.aiProcess_Triangulate
        | postprocess.aiProcess_GenSmoothNormals
        | postprocess.aiProcess_GenUVCoords
        | postprocess.aiProcess_TransformUVCoords
        | postprocess.aiProcess_JoinIdenticalVertices
        | postprocess.aiProcess_ImproveCacheLocality
        | postprocess.aiProcess_FindInstances
        | postprocess.aiProcess_FixInfacingNormals
        | postprocess.aiProcess_PreTransformVertices
    )
    return flags


def _assimp_last_error() -> str:
    """Best-effort ``aiGetErrorString()`` lookup.

    pyassimp's ``AssimpError`` is hard-coded to the literal "Could not
    import file!" string regardless of why import actually failed.  The
    real reason is sitting in libassimp's per-thread error slot, reachable
    via the C function ``aiGetErrorString``.  Surfacing it on the way up
    saves the next debugger an hour of strace.

    Returns an empty string if the lookup itself fails.
    """
    try:
        import ctypes
        from pyassimp import helper as _helper

        lib_path = None
        candidates = list(getattr(_helper, "additional_dirs", []) or []) + [
            "/opt/assimp/lib",
            "/usr/local/lib",
            "/usr/lib/x86_64-linux-gnu",
            "/usr/lib",
        ]
        for d in candidates:
            for fn in (
                "libassimp.so",
                "libassimp.so.5",
                "libassimp.so.5.4",
                "libassimp.so.5.4.3",
            ):
                p = f"{d}/{fn}"
                try:
                    open(p, "rb").close()
                except OSError:
                    continue
                lib_path = p
                break
            if lib_path:
                break
        dll = ctypes.cdll.LoadLibrary(lib_path or "libassimp.so")
        dll.aiGetErrorString.restype = ctypes.c_char_p
        dll.aiGetErrorString.argtypes = []
        raw = dll.aiGetErrorString()
        if not raw:
            return ""
        return raw.decode("utf-8", errors="replace").strip()
    except Exception:  # pragma: no cover - diagnostic only
        return ""


def convert_file_to_glb(
    src_path: Path,
    work_dir: Path,
    options: PreconvertOptions,
) -> Path:
    """Convert an Assimp-readable mesh (e.g. ``.3ds``) into a binary glTF.

    Used by the fixtures service to turn GDTF ``./models/3ds`` meshes into the
    GLB the web Three.js viewer can load. Returns the path to ``model.glb``
    under ``work_dir``. Node transforms are baked into the vertices (see
    :func:`_postprocess_flags`) so the single-mesh output matches what the
    GDTF geometry tree expects. Scale is irrelevant downstream — the viewer
    fits the mesh bbox to the GDTF model dimensions — so we leave units as
    authored.
    """
    logger.info("convert-glb src=%s options=%s", src_path, options)

    out_path = work_dir / "model.glb"

    import pyassimp  # type: ignore
    from pyassimp import postprocess  # type: ignore

    flags = _postprocess_flags(options)

    scene = None
    try:
        scene = pyassimp.load(str(src_path), processing=flags)
        if not list(getattr(scene, "meshes", []) or []):
            raise RuntimeError("source file contains no meshes")
        # "glb2" = binary glTF 2.0 exporter (Assimp 5.x). Re-triangulate on
        # export as a belt-and-brace; the load pass already triangulated.
        pyassimp.export(
            scene,
            str(out_path),
            file_type="glb2",
            processing=postprocess.aiProcess_Triangulate,
        )
    except pyassimp.AssimpError as exc:
        detail = _assimp_last_error()
        logger.exception(
            "assimp failed to load %s (aiGetErrorString=%r)", src_path, detail
        )
        raise RuntimeError(
            f"Assimp failed to load file: {detail or exc}"
        ) from exc
    finally:
        if scene is not None:
            try:
                pyassimp.release(scene)
            except Exception:
                logger.exception("pyassimp.release raised; ignoring")

    if not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError("GLB export produced no output")
    return out_path


def preconvert_file(
    src_path: Path,
    bundle_path: Optional[Path],
    work_dir: Path,
    options: PreconvertOptions,
) -> PreconvertResult:
    """Convert ``src_path`` into an OBJ+MTL+textures.zip under ``work_dir``.

    Returns a :class:`PreconvertResult` that the FastAPI layer turns into
    a JSON response or a raw file stream.
    """
    logger.info(
        "preconvert src=%s bundle=%s options=%s",
        src_path,
        bundle_path,
        options,
    )

    bundle_dir = _expand_bundle(bundle_path, work_dir)

    obj_path = work_dir / "model.obj"
    mtl_path = work_dir / "model.mtl"
    manifest_path = work_dir / "manifest.json"
    texture_dir = work_dir / "textures"
    texture_dir.mkdir(parents=True, exist_ok=True)

    scale = _UNIT_TO_METRES.get(options.target_unit, 1.0)

    # Defer the imports that need libassimp until we actually run, so unit
    # tests against the FastAPI surface don't transitively require the
    # native library.
    import pyassimp  # type: ignore
    from .layers import build_collada_layer_map, walk_leaves
    from .materials import emit_mtl_and_textures
    from .packaging import build_zip, write_manifest, write_obj

    # Format-specific human-name extraction, before we hand the file to
    # libassimp.  Today only COLLADA is supported -- other formats fall
    # back to the corrected `mName` decode in walk_leaves.
    layer_map = build_collada_layer_map(src_path)
    if layer_map:
        logger.info(
            "preconvert: layer-map source=collada-xml entries=%d", len(layer_map)
        )

    flags = _postprocess_flags(options)

    # pyassimp 4.1.4's `Scene` is not a context manager (the `with`-form
    # only landed on master post-release, never shipped to PyPI).  Stick
    # to the documented try/finally + release() pattern; `release` is a
    # no-op if `scene` failed to load.
    scene = None
    try:
        scene = pyassimp.load(str(src_path), processing=flags)
        leaves = list(walk_leaves(scene, layer_map=layer_map))
        materials_bundle = emit_mtl_and_textures(
            scene,
            src_path.parent,
            mtl_path,
            texture_dir,
            bundle_dir,
        )
        obj_stats = write_obj(
            obj_path,
            "model.mtl",
            scene,
            leaves,
            materials_bundle.materials,
            scale=scale,
        )
        manifest = write_manifest(manifest_path, leaves, materials_bundle)
        mesh_count = len(list(getattr(scene, "meshes", []) or []))
    except pyassimp.AssimpError as exc:
        # pyassimp's exception always carries the literal "Could not import
        # file!" -- the real reason is in libassimp's aiGetErrorString slot.
        detail = _assimp_last_error()
        logger.exception(
            "assimp failed to load %s (aiGetErrorString=%r)", src_path, detail
        )
        if detail:
            raise RuntimeError(
                f"Assimp failed to load file: {detail}"
            ) from exc
        raise RuntimeError(f"Assimp failed to load file: {exc}") from exc
    finally:
        if scene is not None:
            try:
                pyassimp.release(scene)
            except Exception:
                logger.exception("pyassimp.release raised; ignoring")

    files_to_pack = [obj_path, mtl_path, manifest_path]
    files_to_pack.extend(p for p in texture_dir.iterdir() if p.is_file())
    zip_path = work_dir / "model.zip"
    build_zip(zip_path, files_to_pack, work_dir)

    texture_count = sum(1 for _ in texture_dir.iterdir() if _.is_file())

    stats: Dict[str, Any] = {
        "meshes": mesh_count,
        "vertices": obj_stats["vertices"],
        "triangles": obj_stats["triangles"],
        "groups": obj_stats["groups"],
        "materials": len(materials_bundle.materials),
        "textures": texture_count,
        "leaves": len(leaves),
        "scale_to_metres": scale,
    }

    return PreconvertResult(
        obj_path=obj_path,
        mtl_path=mtl_path,
        zip_path=zip_path,
        stats=stats,
        manifest=manifest,
    )
