#!/usr/bin/env python3
"""Split a downloaded .excalidrawlib file into individual icon files.

Usage:
    python split-excalidraw-library.py <library-dir>

The library directory must contain a single `.excalidrawlib` file (e.g.
`aws-architecture-icons.excalidrawlib`). This script writes:

  <library-dir>/reference.md     Icon lookup table
  <library-dir>/icons/*.json     One file per icon (its own Excalidraw scene)
"""

import json
import sys
import pathlib


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    lib_dir = pathlib.Path(sys.argv[1])
    if not lib_dir.is_dir():
        print(f"error: {lib_dir} is not a directory", file=sys.stderr)
        return 1

    lib_files = list(lib_dir.glob("*.excalidrawlib"))
    if not lib_files:
        print(
            f"error: no .excalidrawlib file found in {lib_dir}",
            file=sys.stderr,
        )
        return 1
    if len(lib_files) > 1:
        print(
            f"error: multiple .excalidrawlib files found in {lib_dir}: "
            f"{[f.name for f in lib_files]}",
            file=sys.stderr,
        )
        return 1

    src = lib_files[0]
    try:
        items = json.loads(src.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"error: {src.name} is not valid JSON: {exc}", file=sys.stderr)
        return 1

    if not isinstance(items, list):
        print("error: .excalidrawlib root must be a JSON array", file=sys.stderr)
        return 1

    icons_dir = lib_dir / "icons"
    icons_dir.mkdir(exist_ok=True)

    icons = []
    for idx, item in enumerate(items):
        name = item.get("name") or f"icon-{idx:03d}"
        elements = item.get("elements", [])
        # The library item is itself an Excalidraw scene: wrap it as a file.
        scene = {
            "type": "excalidraw",
            "version": 2,
            "source": "https://excalidraw.com",
            "elements": elements,
            "appState": {"viewBackgroundColor": "#ffffff", "gridSize": 20},
            "files": {},
        }
        slug = _slugify(name)
        out = icons_dir / f"{slug}.json"
        out.write_text(json.dumps(scene, indent=2) + "\n", encoding="utf-8")
        icons.append((slug, name, len(elements)))

    lines = ["# Library reference", ""]
    lines.append(f"Library: `{src.name}` — {len(icons)} icons")
    lines.append("")
    lines.append("| Icon file | Icon name | Elements |")
    lines.append("|-----------|-----------|----------|")
    for slug, name, count in icons:
        lines.append(f"| `{slug}.json` | {name} | {count} |")
    lines.append("")
    lines.append("Use the `icons/<file>.json` paths with `add-icon-to-diagram.py`.")

    (lib_dir / "reference.md").write_text("\n".join(lines), encoding="utf-8")

    print(f"Wrote {len(icons)} icons to {icons_dir}/")
    print(f"Wrote reference table to {lib_dir / 'reference.md'}")
    return 0


def _slugify(name: str) -> str:
    out = []
    for ch in name:
        if ch.isalnum() or ch in "-_":
            out.append(ch)
        elif ch in " /\\":
            out.append("-")
    return "".join(out).strip("-") or "icon"


if __name__ == "__main__":
    raise SystemExit(main())