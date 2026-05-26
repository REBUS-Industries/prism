"""Node-tree -> OBJ group path normalisation.

Walks an `aiScene` rooted at ``scene.rootnode`` depth-first and yields one
``LeafRecord`` per (node, mesh) pair so the OBJ emitter can produce a
``g <path>`` line per visible chunk of geometry while the manifest writer
gets a complete picture of the layer hierarchy.
"""

from __future__ import annotations

import ctypes
import logging
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("prism-assimp.layers")


# ---------------------------------------------------------------------------
# pyassimp 4.1.4 aiString workaround
# ---------------------------------------------------------------------------
# The C ``aiString`` from <assimp/types.h> is laid out as
#   ai_uint32 length;
#   char data[1024];
# so the actual UTF-8 payload starts at byte offset 4.  pyassimp 4.1.4's
# ``structs.String`` declares ``length`` with a 64-bit ctypes type, which
# pushes its ``data`` field to byte offset 8 instead of 4 -- so every name
# read through pyassimp comes back missing the first four characters
# (``VisualSceneNode`` reads as ``alSceneNode``, ``View-Front`` reads as
# ``-Front``, and Rhino-exported COLLADA UUIDs all lose their first four
# hex digits).  See ORBIT/PRISM/assimp/docs/INTEGRATION.md for the trace.
#
# Instead of patching pyassimp, just read the raw bytes back at the
# correct offset.  ``ctypes.addressof(s)`` gives us the start of the C
# struct in memory regardless of how pyassimp's wrapper happens to type
# the fields.
def decode_aistring(s: object) -> str:
    """Return the UTF-8 payload of a pyassimp ``String`` struct."""
    try:
        addr = ctypes.addressof(s)  # type: ignore[arg-type]
    except Exception:
        return ""
    raw = (ctypes.c_ubyte * 1028).from_address(addr)
    length = int.from_bytes(bytes(raw[0:4]), "little")
    if length == 0 or length > 1024:
        return ""
    try:
        return bytes(raw[4 : 4 + length]).decode("utf-8", errors="replace")
    except Exception:
        return ""


def mesh_name(mesh: object) -> str:
    """Best-effort mesh name from a pyassimp ``Mesh``.

    Tries (in order) the raw ``mesh.contents.mName`` decode (works for
    pyassimp's Node struct -- broken for Mesh because pyassimp's Mesh
    struct definition has a different layout error that puts
    ``addressof(mName)`` at the *data* field rather than the length
    field), then ``mesh.contents.mName.data`` (which produces the
    8-char-truncated string for meshes), and finally
    ``mesh.name`` (also 8-char-truncated for meshes).  Callers should
    treat the result as "possibly a suffix of the real name" and use
    :func:`lookup_layer` for matching against a known-good map.
    """
    contents = getattr(mesh, "contents", None)
    if contents is not None:
        raw = getattr(contents, "mName", None)
        if raw is not None:
            decoded = decode_aistring(raw)
            if decoded:
                return decoded
            try:
                # pyassimp's `.data` accessor returns an already-truncated
                # bytes view; better than nothing.
                buf = getattr(raw, "data", None)
                if buf is not None:
                    if isinstance(buf, bytes):
                        return buf.decode("utf-8", errors="ignore").rstrip("\x00")
            except Exception:
                pass
    fallback = getattr(mesh, "name", None) or ""
    if isinstance(fallback, bytes):
        fallback = fallback.decode("utf-8", errors="ignore")
    return fallback


def lookup_layer(layer_map: Dict[str, str], pyassimp_mesh_name: str) -> Optional[str]:
    """Find ``layer_map[mesh_name]`` accounting for pyassimp string
    truncation.

    Tries an exact match first; falls back to a suffix-match scan because
    pyassimp 4.1.4 returns a (4 or 8 char) suffix-cropped mesh name -- so
    our XML-extracted key ``"da20ae4b-..."`` matches pyassimp's reported
    ``"0ae4b-..."`` (or even ``"4b-..."`` on more-broken pyassimp
    builds).  UUIDs make false-positive matches astronomically unlikely.
    """
    if not pyassimp_mesh_name or not layer_map:
        return None
    direct = layer_map.get(pyassimp_mesh_name)
    if direct is not None:
        return direct
    for key, value in layer_map.items():
        if key.endswith(pyassimp_mesh_name):
            return value
    return None


# ---------------------------------------------------------------------------
# Format-specific layer-name extraction
# ---------------------------------------------------------------------------
# Assimp's COLLADA importer stores ``<node id="...">`` in ``aiNode.mName``
# and discards ``<node name="...">`` -- but Rhino's exporter writes the
# human-readable layer name on the ``name`` attribute and a synthetic UUID
# on ``id``.  So even a perfectly-decoded mName comes back as a UUID.
#
# Recover the human name by parsing the COLLADA XML directly: walk every
# ``<node>`` and every ``<instance_geometry url="#mesh-<UUID>">`` it
# contains, and map that geometry id (without the ``mesh-`` prefix that
# Assimp also strips) to the parent node's ``name`` attribute.
_COLLADA_NS = "{http://www.collada.org/2005/11/COLLADASchema}"


def _walk_collada_nodes(elem: ET.Element, parent_name: str, mapping: Dict[str, str]) -> None:
    """Recursively populate ``geometry_id -> human node name``."""
    name = elem.get("name") or elem.get("id") or parent_name
    for child in elem:
        if child.tag == _COLLADA_NS + "instance_geometry":
            url = child.get("url", "")
            if url.startswith("#mesh-"):
                geom_id = url[len("#mesh-") :]
            elif url.startswith("#"):
                geom_id = url[1:]
            else:
                geom_id = url
            if geom_id and geom_id not in mapping:
                mapping[geom_id] = name
        elif child.tag == _COLLADA_NS + "node":
            _walk_collada_nodes(child, name, mapping)


def build_collada_layer_map(src_path: Path) -> Dict[str, str]:
    """Map mesh-name (Assimp's ``mName`` for a COLLADA import, equal to
    the ``<geometry id>`` minus the ``mesh-`` prefix) to the
    human-readable ``<node name>`` attribute that wraps the corresponding
    ``<instance_geometry>``.

    Returns an empty dict for non-COLLADA inputs or unparseable XML so
    callers can blindly merge it into a higher-level mapping.
    """
    if src_path.suffix.lower() != ".dae":
        return {}
    try:
        tree = ET.parse(src_path)
    except Exception:  # pragma: no cover - bad XML is still a valid input for assimp
        logger.exception("collada-xml-parse-failed: %s", src_path)
        return {}
    mapping: Dict[str, str] = {}
    for visual_scene in tree.iter(_COLLADA_NS + "visual_scene"):
        for top_node in visual_scene.findall(_COLLADA_NS + "node"):
            _walk_collada_nodes(top_node, top_node.get("name", "") or "", mapping)
    if mapping:
        logger.info(
            "collada-layer-map: extracted %d geometry-id -> node-name entries",
            len(mapping),
        )
    return mapping


@dataclass(frozen=True)
class LeafRecord:
    """A renderable node-mesh pair in the scene graph.

    Attributes
    ----------
    layer_path
        Slash-separated path from scene root down to the owning node, with
        characters illegal in OBJ group names escaped.  Used verbatim as
        the value of ``g <layer_path>`` in the emitted OBJ.
    mesh_index
        Index into ``scene.meshes``.
    material_index
        Index into ``scene.materials``.  Mirrors the aiMesh's
        ``material_index`` for convenience so the OBJ writer doesn't need
        to dereference the mesh again.
    world_transform
        4x4 row-major matrix accumulated from the scene root to the owning
        node.  OBJ has no transform syntax so vertices and normals are
        pre-multiplied before emission.
    """

    layer_path: str
    mesh_index: int
    material_index: int
    world_transform: Tuple[float, ...]  # 16 floats, row-major


def sanitise_group_name(name: Optional[str], fallback: str) -> str:
    """OBJ group names cannot contain whitespace; we also strip ``/`` so
    nested paths can be reconstructed losslessly when the importer splits
    on ``/``.
    """
    if name is None:
        return fallback
    cleaned = (
        name.strip()
        .replace("/", "_")
        .replace(" ", "_")
        .replace("\t", "_")
        .replace("\r", "")
        .replace("\n", "")
    )
    return cleaned or fallback


def _node_meshes(node: object, scene_meshes: List[object]) -> List[Tuple[int, object]]:
    """pyassimp's ``node.meshes`` flips between "list of indices" and "list
    of resolved Mesh objects" depending on version and how the scene was
    loaded.  Normalise to ``[(index, mesh), ...]``.
    """
    raw = getattr(node, "meshes", None) or []
    out: List[Tuple[int, object]] = []
    for entry in raw:
        if isinstance(entry, (int, np.integer)):
            idx = int(entry)
            if 0 <= idx < len(scene_meshes):
                out.append((idx, scene_meshes[idx]))
        else:
            try:
                idx = scene_meshes.index(entry)
            except ValueError:
                # Mesh isn't in the scene mesh list (shouldn't happen, but be safe).
                continue
            out.append((idx, entry))
    return out


_IDENTITY_4X4 = tuple(float(v) for v in np.eye(4, dtype=np.float64).ravel())


def walk_leaves(
    scene: object,
    layer_map: Optional[Dict[str, str]] = None,
) -> Iterator[LeafRecord]:
    """Yield one ``LeafRecord`` per mesh in the scene.

    Implementation note (Phase 1)
    -----------------------------
    The converter calls ``pyassimp.load`` with
    ``aiProcess_PreTransformVertices``, which bakes every node's world
    transform into its meshes and collapses the hierarchy.  We therefore
    read meshes straight off ``scene.meshes`` and use identity transforms
    everywhere.

    Layer naming priority (highest first):
      1. ``layer_map[mesh_name]`` -- format-specific human names
         extracted by the converter pre-pass (e.g.
         :func:`build_collada_layer_map` for ``.dae`` inputs).
      2. The mesh's own ``mName``, decoded via :func:`decode_aistring`
         to bypass pyassimp 4.1.4's 4-character truncation bug.
      3. ``mesh_<index>`` as a deterministic last-resort fallback.

    When two leaves resolve to the same human name (common after
    PreTransformVertices merges by material), each subsequent occurrence
    gets a ``_<n>`` numeric suffix so the OBJ group lines are unique.
    """
    scene_meshes = list(getattr(scene, "meshes", []) or [])
    used: Dict[str, int] = {}
    for mesh_index, mesh in enumerate(scene_meshes):
        material_index = int(getattr(mesh, "materialindex", 0) or 0)
        raw = mesh_name(mesh)
        chosen: Optional[str] = None
        if layer_map and raw:
            chosen = lookup_layer(layer_map, raw)
        if not chosen:
            chosen = raw or None
        layer_seg = sanitise_group_name(chosen, f"mesh_{mesh_index}")
        if layer_seg in used:
            used[layer_seg] += 1
            layer_seg = f"{layer_seg}_{used[layer_seg]}"
        else:
            used[layer_seg] = 0
        yield LeafRecord(
            layer_path=layer_seg,
            mesh_index=mesh_index,
            material_index=material_index,
            world_transform=_IDENTITY_4X4,
        )
