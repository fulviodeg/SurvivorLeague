#!/usr/bin/env python3
"""Add a connecting arrow to an existing .excalidraw diagram.

Usage:
    python add-arrow.py <diagram> <from-x> <from-y> <to-x> <to-y> \\
        [--label "Text"] [--style solid|dashed|dotted] [--color HEX]

Appends a single arrow element between the two given absolute coordinates and
an optional text label bound to the arrow. By default the diagram is NOT
overwritten: the result is written to <diagram>.edit. Pass
--no-use-edit-suffix to edit the file in place.
"""

import argparse
import pathlib
import json
import uuid
import sys

STYLES = {"solid", "dashed", "dotted"}


def load_scene(path: pathlib.Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"error: cannot parse {path}: {exc}", file=sys.stderr)
        sys.exit(1)


def write_scene(path: pathlib.Path, scene: dict) -> None:
    path.write_text(json.dumps(scene, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Add an arrow to an Excalidraw diagram")
    parser.add_argument("diagram", type=pathlib.Path)
    parser.add_argument("from_x", type=float)
    parser.add_argument("from_y", type=float)
    parser.add_argument("to_x", type=float)
    parser.add_argument("to_y", type=float)
    parser.add_argument("--label", default=None, help="Optional text label on the arrow")
    parser.add_argument(
        "--style",
        default="solid",
        choices=sorted(STYLES),
        help="Line stroke style",
    )
    parser.add_argument("--color", default="#1e1e1e", help="Arrow hex color")
    parser.add_argument(
        "--no-use-edit-suffix",
        action="store_true",
        help="Edit the diagram file in place instead of writing <diagram>.edit",
    )
    args = parser.parse_args()

    scene = load_scene(args.diagram)
    elements = scene.setdefault("elements", [])

    dx = args.to_x - args.from_x
    dy = args.to_y - args.from_y

    arrow = {
        "id": uuid.uuid4().hex,
        "type": "arrow",
        "x": args.from_x,
        "y": args.from_y,
        "width": abs(dx),
        "height": abs(dy),
        "angle": 0,
        "strokeColor": args.color,
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": args.style,
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "frameId": None,
        "roundness": {"type": 2},
        "seed": int(uuid.uuid4().int & 0xFFFFFFFF),
        "version": 1,
        "versionNonce": int(uuid.uuid4().int & 0xFFFFFFFF),
        "isDeleted": False,
        "boundElements": [{"id": f"arrow-label-{uuid.uuid4().hex[:8]}", "type": "text"}]
        if args.label
        else None,
        "updated": int(uuid.uuid4().int & 0xFFFFFFFF),
        "link": None,
        "locked": False,
        "points": [[0, 0], [dx, dy]],
        "startBinding": None,
        "endBinding": None,
        "startArrowhead": None,
        "endArrowhead": "arrow",
    }

    if args.label:
        label_id = arrow["boundElements"][0]["id"]
        label = {
            "id": label_id,
            "type": "text",
            "x": args.from_x + dx / 2 - 60,
            "y": args.from_y + dy / 2 - 24,
            "width": 120,
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
            "containerId": arrow["id"],
            "originalText": args.label,
            "text": args.label,
        }
        elements.append(label)

    elements.append(arrow)

    out = args.diagram if args.no_use_edit_suffix else pathlib.Path(f"{args.diagram}.edit")
    write_scene(out, scene)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())