"""Node-tree -> OBJ group path normalisation.

Walks an `aiScene` rooted at ``scene.rootnode`` depth-first and yields one
``LeafRecord`` per (node, mesh) pair so the OBJ emitter can produce a
``g <path>`` line per visible chunk of geometry while the manifest writer
gets a complete picture of the layer hierarchy.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterator, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("prism-assimp.layers")


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


def walk_leaves(scene: object) -> Iterator[LeafRecord]:
    """Yield one ``LeafRecord`` per mesh in the scene.

    Implementation note (Phase 1)
    -----------------------------
    The converter calls ``pyassimp.load`` with
    ``aiProcess_PreTransformVertices``, which bakes every node's world
    transform into its meshes and collapses the hierarchy.  We therefore
    read meshes straight off ``scene.meshes`` and use identity transforms
    everywhere, deriving a layer name from the mesh's own ``name``
    attribute (Assimp populates this from the source format's group /
    object / layer name when one exists).  When the mesh name is empty,
    fall back to ``mesh_<index>`` so the OBJ group line is still
    deterministic.

    Phase 2 will replace this with the per-node DFS that's currently
    blocked by the pyassimp 4.1.4 ``node.transformation`` bug; the
    ``LeafRecord`` shape is intentionally unchanged so that revert is
    contained to this file.
    """
    scene_meshes = list(getattr(scene, "meshes", []) or [])
    for mesh_index, mesh in enumerate(scene_meshes):
        material_index = int(getattr(mesh, "materialindex", 0) or 0)
        raw_name = getattr(mesh, "name", None)
        if isinstance(raw_name, bytes):
            raw_name = raw_name.decode("utf-8", errors="ignore")
        layer_seg = sanitise_group_name(raw_name, f"mesh_{mesh_index}")
        yield LeafRecord(
            layer_path=layer_seg,
            mesh_index=mesh_index,
            material_index=material_index,
            world_transform=_IDENTITY_4X4,
        )
