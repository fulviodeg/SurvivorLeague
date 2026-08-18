# Excalidraw JSON Schema (version 2)

This reference describes the top-level structure of a `.excalidraw` file and the
properties shared by all elements. Files use the `.excalidraw` extension and are
plain JSON that Excalidraw (https://excalidraw.com) opens directly. A file can
also be opened via the Excalidraw VS Code extension.

## Top-level file structure

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [],
  "appState": {},
  "files": {},
  "libraryItems": []
}
```

| Key             | Type                      | Description                                                              |
|-----------------|---------------------------|--------------------------------------------------------------------------|
| `type`          | `"excalidraw"`            | Discriminator for the file format. Always this value.                   |
| `version`       | `2`                       | File schema version. Use `2`.                                           |
| `source`        | string                    | Where the file came from, e.g. `"https://excalidraw.com"`.              |
| `elements`      | `ExcalidrawElement[]`     | The array of shapes/text/arrows drawn on the canvas.                   |
| `appState`      | object                    | View state: background color, grid size, selection, zoom, etc.          |
| `files`         | object                    | Map of image file id → file data (empty `{}` when no images).           |
| `libraryItems`  | array                     | Optional; persistent library items. Usually omitted in generated files. |

## Shared element properties

Every element (rectangle, text, arrow, ellipse, diamond, line, etc.) carries
these base properties:

```json
{
  "id": "a1b2c3d4e5f6g7h8",
  "type": "rectangle",
  "x": 100,
  "y": 120,
  "width": 200,
  "height": 60,
  "angle": 0,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "hachure",
  "strokeWidth": 1,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "groupIds": [],
  "frameId": null,
  "roundness": { "type": 3 },
  "seed": 1720000000000,
  "version": 1,
  "versionNonce": 1720000000000,
  "isDeleted": false,
  "boundElements": null,
  "updated": 1720000000000,
  "link": null,
  "locked": false
}
```

| Property        | Type                    | Description                                                            |
|-----------------|-------------------------|------------------------------------------------------------------------|
| `id`            | string                  | Unique element id. Must be unique within the file.                    |
| `type`          | string                  | Element kind: `rectangle`, `ellipse`, `diamond`, `arrow`, `line`, `text`, etc. |
| `x`, `y`        | number                  | Top-left position in canvas coordinates.                              |
| `width`,`height`| number                  | Bounding box size in pixels.                                          |
| `angle`         | number                  | Rotation radians. `0` for axis-aligned.                               |
| `strokeColor`   | string                  | Line color as hex, e.g. `"#1e1e1e"`.                                  |
| `backgroundColor`| string                 | Fill color hex, or `"transparent"`.                                   |
| `fillStyle`     | string                  | `hachure` (sketchy), `solid`, `cross-hatch`.                          |
| `strokeWidth`   | number                  | Line thickness (usually `1` or `2`).                                  |
| `strokeStyle`   | string                  | `solid`, `dashed`, `dotted`.                                          |
| `roughness`     | number                  | Hand-drawn roughness (e.g. `1`).                                       |
| `opacity`       | number                  | `0`–`100`.                                                            |
| `groupIds`      | string[]                | Ids of groups this element belongs to. Empty `[]` normally.           |
| `frameId`       | string \| `null`        | Id of the parent frame, or `null`.                                     |
| `roundness`     | `{ type: number }` \| `null` | Corner radius strategy. `{ "type": 3 }` = sharp/auto.             |
| `seed`          | number                  | Random seed for sketch rendering. Any number.                          |
| `version`       | number                  | Incrementing version. Start at `1`.                                    |
| `versionNonce`  | number                 | Unique nonce per version. Any number.                                 |
| `isDeleted`     | boolean                 | `false`.                                                              |
| `boundElements` | array \| `null`        | Back-references to bound text/arrows. `null` if none.                 |
| `updated`       | number                  | Timestamp (ms). Any number.                                           |
| `link`          | string \| `null`        | Hyperlink, or `null`.                                                  |
| `locked`        | boolean                 | `false`.                                                              |

## Minimal valid rendering

Excalidraw is permissive about numeric fields (seed, versionNonce, updated) and
will render elements that contain the essential `id`, `type`, `x`, `y`, `width`,
`height` properties. For robust hand-authored files, still include the standard
fields from the shared schema above.

## Validating a generated file

1. Must parse as valid JSON (`JSON.parse` succeeds).
2. Top level must have `type === "excalidraw"`.
3. `elements` must be an array.
4. Every element needs a unique `id`.
5. Text elements must set `fontFamily`.
6. Open the resulting `.excalidraw` in https://excalidraw.com to visually confirm.