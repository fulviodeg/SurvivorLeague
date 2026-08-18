# Excalidraw Skill — Library Tools

The scripts in this directory let an agent build Excalidraw diagrams using the
library-icon workflow without loading hundreds of lines of icon JSON into
context.

## Scripts

- `split-excalidraw-library.py` — split a downloaded `.excalidrawlib` into one
  JSON file per icon plus a `reference.md` lookup table.
- `add-icon-to-diagram.py` — append an icon (from a split library) into a
  diagram at a given coordinate, with an optional label.
- `add-arrow.py` — append a connecting arrow between two coordinates, with an
  optional label, stroke style, and color.

## Setup (one time, per icon set)

```bash
# 1. Download a .excalidrawlib from https://libraries.excalidraw.com/
mkdir -p ../libraries/aws-architecture-icons
mv /path/to/download.excalidrawlib ../libraries/aws-architecture-icons/aws-architecture-icons.excalidrawlib

# 2. Split it into icons/ + reference.md
python split-excalidraw-library.py ../libraries/aws-architecture-icons
```

After splitting, `add-icon-to-diagram.py` finds icons under
`<library>/icons/<icon-name>.json`. Confirm names in `<library>/reference.md`.

## Editing safety

Both `add-*.py` scripts write to `<diagram>.excalidraw.edit` by default so the
original file is never clobbered during a sequence of adds. Overwrite the
original when finished with or pass `--no-use-edit-suffix`.

```bash
# Build a diagram via a .edit suffix, then promote to the final file
mv my-diagram.excalidraw.edit my-diagram.excalidraw
```

## Requirements

- Python 3.10+ (uses only the standard library).

## .gitignore

`./.gitignore` keeps local Python artifacts (`__pycache__/`, `*.pyc`) out of
version control.