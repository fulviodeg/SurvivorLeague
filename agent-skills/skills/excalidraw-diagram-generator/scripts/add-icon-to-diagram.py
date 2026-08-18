#!/usr/bin/env python3
"""Add an icon (from an Excalidraw library) into an existing .excalidraw diagram.

Usage:
    python add-icon-to-diagram.py <diagram> <icon-name> <x> <y> \\
        [--label "Text"] [--library-path PATH] [--no-use-edit-suffix]

The icon is looked up as <library-path>/icons/<icon-name>.json (the output of
`split-excalidraw-library.py`). Icon elements are re-coordinated to sit with
their top-left corner at (x, y), get fresh unique ids, and are appended to the
diagram. An optional text label is bound below the icon.

By default the diagram is NOT overwritten: the result is written to
<diagram>.edit. Pass --no-use-edit-suffix to edit the file in place.
"""

import argparse
import pathlib
import json
import uuid
import sys

DEFAULT_LIBRARY = pathlib.Path(__file__).resolve().parent.parent / "libraries"


def load_scene(path: pathlib.Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"error: cannot parse {path}: {exc}", file=sys.stderr)
        sys.exit(1)


def write_scene(path: pathlib.Path, scene: dict) -> None:
    path.write_text(json.dumps(scene, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {path}")


def bounding_box(elements: list) -> tuple[float, float]:
    min_x = min(e["x"] for e in elements)
    min_y = min(e["y"] for e in elements)
    return min_x, min_y


def remap_ids(elements: list) -> list:
    id_map = {e["id"]: uuid.uuid4().hex for e in elements}
    out = []
    for e in elements:
        copy = dict(e)
        copy["id"] = id_map[e["id"]]
        copy["groupIds"] = [id_map.get(gid, gid) for gid in copy.get("groupIds", [])]
        if copy.get("frameId"):
            copy["frameId"] = id_map.get(copy["frameId"], copy["frameId"])
        for attr in ("boundElements",):
            if copy.get(attr):
                for b in copy[attr]:
                    if b.get("elementId") in id_map:
                        b["elementId"] = id_map[b["elementId"]]
        copy["seed"] = int(uuid.uuid4().int & 0xFFFFFFFF)
        copy["versionNonce"] = int(uuid.uuid4().int & 0xFFFFFFFF)
        out.append(copy)
    return out


def find_icon(library_path: pathlib.Path, icon_name: str) -> dict:
    candidates = [
        library_path / "icons" / f"{icon_name}.json",
        library_path / "icons" / f"{icon_name}.excalidraw.json",
    ]
    if library_path.name == "icons":
        candidates.insert(0, library_path / f"{icon_name}.json")
    for cand in candidates:
        if cand.is_file():
            return load_scene(cand)
    print(
        f"error: icon '{icon_name}' not found under {library_path}/icons/ "
        f"(run split-excalidraw-library.py first, or pass --library-path)",
        file=sys.stderr,
    )
    sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Add an Excalidraw library icon to a diagram")
    parser.add_argument("diagram", type=pathlib.Path)
    parser.add_argument("icon", help="Icon name, e.g. EC2")
    parser.add_argument("x", type=float)
    parser.add_argument("y", type=float)
    parser.add_argument("--label", default=None, help="Optional text label under the icon")
    parser.add_argument(
        "--library-path",
        default=str(DEFAULT_LIBRARY),
        help="Directory containing an `icons/` subfolder (default: the skill's libraries/)",
    )
    parser.add_argument(
        "--no-use-edit-suffix",
        action="store_true",
        help="Edit the diagram file in place instead of writing <diagram>.edit",
    )
    args = parser.parse_args()

    scene = load_scene(args.diagram)
    elements = scene.setdefault("elements", [])

    library_root = pathlib.Path(args.library_path)
    if (library_root / "icons").is_dir():
        library_root = library_root / "icons"
    icon = find_icon(library_root, args.icon)

    icon_elements = icon.get("elements", [])
    if not icon_elements:
        print("error: icon contains no elements", file=sys.stderr)
        return 1

    ox, oy = bounding_box(icon_elements)
    new_elements = remap_ids(icon_elements)
    for e in new_elements:
        e["x"] += args.x - ox
        e["y"] += args.y - oy

    elements.extend(new_elements)

    if args.label:
        label = {
            "id": uuid.uuid4().hex,
            "type": "text",
            "x": args.x,
            "y": args.y + (max(e["y"] + e["height"] for e in new_elements) - args.y) + 8,
            "width": 160,
            "height": 20,
            "angle": 0,
            "strokeColor": "#1e1e1e",
            "backgroundColor": "transparent",
            "fillStyle": "hachure",
            "strokeWidth": 1,
            "strokeStyle": "solid",
            "roughness": 1,
            "opacity": 100,
            "groupIds": [],
            "frameId": None,
            "roundness": None,
            "seed": int(uuid.uuid4().int & 0xFFFFFFFF),
            "version": 1,
            "versionNonce": int(uuid.uuid4().int & 0xFFFFFFFF),
            "isDeleted": False,
            "boundElements": None,
            "updated": int(uuid.uuid4().int & 0xFFFFFFFF),
            "link": None,
            "locked": False,
            "fontSize": 16,
            "fontFamily": 5,
            "textAlign": "center",
            "verticalAlign": "top",
            "containerId": None,
            "originalText": args.label,
            "text": args.label,
        }
        elements.append(label)

    out = args.diagram if args.no_use_edit_suffix else pathlib.Path(f"{args.diagram}.edit")
    write_scene(out, scene)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())