---
name: excalidraw-information-design
description: 'Enforce professional Information Design standards on every Excalidraw diagram: layout and visual hierarchy, spacing, semantic color and typography rules, and valid Excalidraw JSON conventions. Use together with excalidraw-diagram-generator for any request to create, redesign, or polish an Excalidraw diagram (timelines, flowcharts, mind maps, architectures, swimlanes, ER, sequence, class diagrams). Output must read in seconds, be visually balanced, and follow a consistent hand-drawn Excalidraw style.'
---

# Excalidraw Information Design

Rules for producing professional-quality Excalidraw diagrams: readable in seconds, visually balanced, understandable by non-technical people. This skill governs **design quality**; `excalidraw-diagram-generator` governs **generation mechanics**. Apply both to every diagram request.

## When to Use This Skill

- Any request to create an Excalidraw diagram (any type: timeline, flowchart, mind map, architecture, data flow, swimlane, sequence, ER, class).
- Any request to redesign or polish an existing `.excalidraw` file.
- Closest to `frontend-ui-engineering`, but for static diagrams instead of interactive UI.

## Operating Principles

1. **Dominant reading axis first** — the diagram defines one primary structure (time for timelines, flow left-to-right/top-down for flowcharts, radial for mind maps, layer grid for architectures) and everything is subordinate to it.
2. **Progressive disclosure** — general flow first (title → axes → macro-phases), details last (descriptive boxes, bullets, notes). The whole diagram must be understood in ≤ 15 seconds.
3. **Gestalt grouping** — use proximity, continuity, and similarity so related items visually group themselves; no labels needed to explain structure.
4. **Minimalism** — add an element only if it carries information that cannot be inferred. Empty space is a design tool, not waste.

---

## 1 — Layout, Spacing, and Visual Hierarchy

- **L1 — Primary reading axis.** The diagram has one explicit dominant structure: an axis (timeline), a flow direction, a radial center, or a layered grid. All elements are subordinate to it.
- **L2 — Distinct roles live in parallel blocks.** Every entity, role, layer, or parallel flow occupies its own parallel block (lane, row, layer, or swimlane), separated from and aligned with the others; elements of different roles must never be stacked on or overlapped with each other. Elements sharing the same logical reference (time instant, phase, entity) align on the same coordinate across the parallel blocks.
- **L3 — Four-level visual hierarchy.** 1) main title, 2) window/container names, 3) dates or reference labels, 4) descriptions. Level 1 stands out immediately (large, dark); levels 3–4 stay discreet.
- **L4 — Progressive disclosure.** General flow first, details last; the viewer must grasp the overall cycle/flow without reading a single box.
- **L5 — At-a-glance readability.** Total comprehension in ≤ 15 seconds; remove any element that adds no information.
- **L6 — Whitespace is a design tool.** Generous margins, constant spacing between homogeneous elements, uniform gaps. Descriptive boxes are capped at 3–5 bullet points and 40–50 words total.
- **L7 — Anti-clutter alternation.** Distribute descriptive elements over multiple rows (e.g., two alternating rows above/below the axis) so horizontally adjacent boxes are never on the same row.
- **L8 — Overlaps are shown by alignment, never by stacking.** Concurrent or dependent events are shown on distinct parallel blocks aligned at the same coordinate — never as visually overlapping bars.
- **L9 — Dependencies without crossings.** Arrows all point in the single reading direction; connectors stay vertical/horizontal; no line crossings. When alignment already expresses a dependency, the connecting line is optional.
- **L10 — Dimensional consistency.** Windows/bars of the same kind: uniform thickness, uniformly rounded corners, uniform box width. Markers of the same concept always share the same shape and size (e.g., circles for events).

## 2 — Graphic Style, Colors, Typography, and Formatting

- **S1 — Hand-drawn Excalidraw style.** Native roughness (`roughness: 1` on shapes); **no** 3D effects, shadows, gradients, or decorations.
- **S2 — Rounded corners.** Every container (window bars, boxes, tags) uses `roundness: {type: 3}`.
- **S3 — Constant semantic color language.** Each concept keeps one color throughout the diagram. Saturate but stay soft (stroke + pastel fill pairs):
  | Role | Stroke | Fill |
  |---|---|---|
  | Start / open | `#2f9e44` | `#b2f2bb` |
  | Active window / pick | `#e8590c` | `#ffd8a8` |
  | Category / theme (e.g., championship) | `#1971c2` | `#a5d8ff` |
  | Processing / pending (count, freeze) | `#7048e8` | `#d0bfff` |
  | Deadline / close / error | `#e03131` | `#ffc9c9` |
  | Neutral (axes, metadata, notes) | `#868e96` | `#e9ecef` |
- **S4 — Descriptive boxes: transparent and consistent.** Transparent fill (`backgroundAlpha: 0`), colored border, text in the same color as the border, rounded corners, uniform width.
- **S5 — Windows/bars: solid pastel fills.** Pastel solid fill + darker semantic stroke, short label inside the bar, full alignment with the axis coordinates.
- **S6 — Single font: Excalifont.** `fontFamily: 5` on **every** text element. Hierarchy by size alone: title 28–32, window/box names 14–16 bold, dates/labels 12–13, descriptions 13. Body text never smaller than 12px.
- **S7 — Minimal text.** Short phrases, never paragraphs; bullets open with "•"; max 3–5 points per box; box titles are ≤ 6 words.
- **S8 — Uniform markers.** Events = filled semantic-color circles placed on the reference (axis/lane); identical size and shape for the same event kind everywhere.
- **S9 — Legend when color is informative.** If more than 2 colors carry semantics, add chips (30×30 colored rect + label) using the same palette, plus a small "Legend" heading.
- **S10 — Role headers.** Lane/block headers are short, uppercase, 13px gray text left-aligned (e.g., "SYSTEM — AUTOMATION").
- **S11 — Micro-labels.** Small annotations such as "open", "deadline", "end of UPP" use the concept's own color, 11px.

## 3 — Logical Structure and Excalidraw Conventions

- **E1 — Valid file format.** `.excalidraw` file: JSON v2 with `type: "excalidraw"`, `version: 2`, `source: "https://excalidraw.com"`, the `elements` array, `appState` (`viewBackgroundColor`, `gridSize`), and `files: {}`.
- **E2 — Required element fields.** Every element: `id` (unique string), `type`, `x`, `y`, `width`, `height`, `angle`, `strokeColor`, `backgroundColor`, `fillStyle`, `strokeWidth`, `strokeStyle`, `roughness`, `opacity`, `groupIds`, `frameId`, `roundness`, `locked`. Text adds `fontSize`, `fontFamily: 5`, `fontStyle`, `textAlign`, `verticalAlign`, `containerId`, `originalText`, `lineHeight`. Lines/arrows carry `points: [[0,0],[dx,dy]]`; arrows use `startArrowhead: null` and `endArrowhead: "arrow"`.
- **E3 — Coordinate model.** `x`,`y` = top-left corner; ellipse markers defined from their center: `x = cx - d/2`, `y = cy - d/2`.
- **E4 — Render order (z-order).** Elements render in array order: background/band guides first, then axes, then bars/windows, then markers and connectors, then text and labels. Position order matches this.
- **E5 — Deterministic generation.** Unique IDs; compute coordinates from a single layout model (constants for dimensions/gaps) and helper functions — never hand-place one coordinate at a time.
- **E6 — Transparency semantics.** `backgroundAlpha` controls fill transparency only (0 = transparent fill, < 1 = tinted fills, e.g., lane bands at ~0.30); `opacity` affects the whole element.
- **E7 — Anchoring and alignment.** Elements anchored to the same logical reference share the same coordinate; thin vertical connectors (`strokeWidth: 1.5`, `opacity` 55–70) lead from the element to its descriptive box.
- **E8 — ID naming.** Readable, prefixed IDs: `e-` events, `bar-` windows/bars, `tk-` ticks/markers, `lb-` labels, `ax-` annotations, `cn-` connectors, `ar-` arrows (e.g., `e-dead-n`, `bar-tcn`, `lb-pick-n`).
- **E9 — Mandatory validation checklist.** Before delivery:
  1. The file parses as valid JSON.
  2. All element `id`s are unique.
  3. Geometric audit: no unintended overlapping pairs between visible containers.
  4. Estimated text width fits its container: `chars × fontSize × 0.52`.
  5. Every text element uses `fontFamily: 5`.
  6. No text below 12px except micro-labels (11px).
- **E10 — Scale guardrails.** Keep total elements ≤ ~150 per canvas and ≤ ~30 boxes per phase; if content exceeds this, split into multiple connected diagrams instead of cramming.

---

## Typical Workflow

1. **Plan:** identify the dominant axis, the distinct parallel blocks (L1, L2), the 4-level hierarchy (L3), and which events/boxes can be alternated (L7).
2. **Generate:** build the `.excalidraw` JSON with a layout model + helpers (E5), using the semantic palette (S3), the typography scale (S6), and the render-order convention (E4).
3. **Validate:** run the E9 checklist; verify the JSON opens in Excalidraw (drag & drop on https://excalidraw.com).
4. **Deliver:** state the file path, the diagram type, the element count, and how to open it.