# Excalidraw Element Types

Reference for the element `type` values used when generating `.excalidraw`
files, and the extra properties each type requires.

## Common vocabulary

- **strokeColor** — shape outline color (hex or `"transparent"`).
- **backgroundColor** — shape fill color (hex or `"transparent"`).
- **fillStyle** — `hachure`, `solid`, `cross-hatch`.
- **strokeStyle** — `solid`, `dashed`, `dotted`.
- All text uses `fontFamily: 5` (Excalifont) per the skill's convention.

## rectangle

Shapes such as steps, entities, and containers.

```json
{
  "type": "rectangle",
  "x": 100, "y": 120, "width": 200, "height": 60,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "#a5d8ff",
  "fillStyle": "hachure",
  "strokeWidth": 1,
  "strokeStyle": "solid",
  "roundness": { "type": 3 }
}
```

## ellipse

Used for start/end nodes, entities, or emphasis. Same shape base as rectangle.

```json
{
  "type": "ellipse",
  "x": 100, "y": 160, "width": 160, "height": 80
}
```

## diamond

Decision/condition nodes in flowcharts. Dimensions behave like a rotated square
bounding box.

```json
{
  "type": "diamond",
  "x": 100, "y": 300, "width": 180, "height": 100,
  "backgroundColor": "#ffd43b"
}
```

## text

Free-standing labels. Includes text-specific fields.

```json
{
  "type": "text",
  "x": 110, "y": 132,
  "width": 180, "height": 25,
  "fontSize": 20,
  "fontFamily": 5,
  "textAlign": "center",
  "verticalAlign": "top",
  "text": "Step 1",
  "containerId": null,
  "originalText": "Step 1",
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent"
}
```

| Property       | Description                                                      |
|----------------|------------------------------------------------------------------|
| `fontSize`     | Pixel size, e.g. `20`. Readable range 16–24.                     |
| `fontFamily`   | `5` = Excalifont (required by this skill).                       |
| `textAlign`    | `left`, `center`, `right`.                                       |
| `verticalAlign`| `top`.                                                           |
| `text`         | The displayed text. Multiline via `\n`.                          |
| `containerId`  | Id of the container shape if the text is bound to it, else `null`.|
| `originalText` | Original pre-wrapping text. Keep equal to `text`.                |

To bind a label to a shape, set the text's `containerId` to the shape id and add
the binding back-reference in the shape's `boundElements`.

## arrow

Directed connectors. Ids of the two endpoint elements belong in
`startBinding` / `endBinding` (with the elementId and a focus value). If exact
element binding is not used, provide `points` so the arrow renders.

```json
{
  "type": "arrow",
  "x": 100, "y": 80,
  "width": 120, "height": 40,
  "points": [
    [0, 0],
    [120, 40]
  ],
  "startBinding": null,
  "endBinding": null,
  "strokeColor": "#1e1e1e",
  "startArrowhead": null,
  "endArrowhead": "arrow",
  "roundness": { "type": 2 }
}
```

| Property          | Description                                       |
|-------------------|---------------------------------------------------|
| `points`          | Array of `[x, y]` offsets along the arrow path.   |
| `startBinding`    | Object `{ type, elementId, focus, gap }` or `null`.|
| `endBinding`      | Object `{ type, elementId, focus, gap }` or `null`.|
| `startArrowhead`  | `null`, `arrow`, `dot`, `bar`.                    |
| `endArrowhead`    | Arrowhead style on the head end (usually `"arrow"`).|

## line

Plain lines (no arrowheads), for lifelines or non-directional connectors.

```json
{
  "type": "line",
  "x": 100, "y": 100, "width": 200, "height": 0,
  "points": [[0, 0], [200, 0]]
}
```

## Notes on bindings

- To connect an arrow between two shapes, set each of `startBinding` /
  `endBinding` to an object such as:
  `{ "type": "arrow", "elementId": "<shape-id>", "focus": 0.5, "gap": 8 }`.
- To label an arrow, add a separate `text` element with `containerId` set to the
  arrow id and `boundElements` on the arrow referencing the text id.
- Simplify when accuracy is not critical: unbound arrows with a sensible
  `points` array still render and export fine.