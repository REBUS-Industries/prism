"""Unit tests for OBJ group-name sanitisation (no libassimp required)."""

from assimp_service.layers import sanitise_group_name


def test_uuid_mesh_names_are_prefixed():
    uid = "018a210d-8ba4-705c-b111-1f1776f7f578"
    assert sanitise_group_name(uid, "mesh_0") == f"mesh_{uid}"


def test_human_names_unchanged():
    assert sanitise_group_name("Body/Left", "mesh_0") == "Body_Left"
    assert sanitise_group_name("Stage Clamp", "mesh_0") == "Stage_Clamp"


def test_empty_falls_back():
    assert sanitise_group_name(None, "mesh_0") == "mesh_0"
    assert sanitise_group_name("   ", "mesh_0") == "mesh_0"
