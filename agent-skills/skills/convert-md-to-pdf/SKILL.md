---
name: convert-md-to-pdf
description: 'Convert Markdown files (including Mermaid diagrams) to professionally styled PDF. Use when the user asks to export/convert .md content to .pdf, generate PDF documentation, or create printable documents. Supports configurable CSS styles (default, modern, minimal, report).'
---

# Convert Markdown to PDF

Convert Markdown files to professionally styled PDFs, with support for Mermaid diagrams rendered as images.

## Usage

Run the included Python script located in this skill's `scripts/` directory:

```bash
python agent-skills/skills/convert-md-to-pdf/scripts/converter.py <input.md> [output.pdf] [--style=STYLE]
```

- `input.md` — required: path to the Markdown file to convert.
- `output.pdf` — optional; defaults to the input path with a `.pdf` extension.
- `--style` — optional CSS style, one of `default`, `modern`, `minimal`, `report`. Defaults to `default`.

You can run it from anywhere by passing absolute paths for `<input.md>` and `<output.pdf>`.

## Available Styles

CSS files live in `agent-skills/skills/convert-md-to-pdf/styles/`:

- `default` — clean sans-serif, professional
- `modern` — bold headers, accent colors
- `minimal` — serif font, whitespace
- `report` — formal corporate style

## First-run setup

Install the Python dependencies listed in `agent-skills/skills/convert-md-to-pdf/requirements.txt`:

```bash
pip install -r agent-skills/skills/convert-md-to-pdf/requirements.txt
```

For Markdown files containing `mermaid` code blocks, the Mermaid CLI is required:

```bash
npm install @mermaid-js/mermaid-cli
```

**Linux / AppArmor systems** (e.g. Ubuntu 23.10+): create a `puppeteer-config.json` in the project root so Puppeteer (used by Mermaid) can launch Chrome for diagram rendering:

```json
{
  "args": ["--no-sandbox", "--disable-setuid-sandbox"]
}
```

The converter script handles its own temp directory, so no extra step is needed.

## Supported Markdown

- Headings, paragraphs, inline emphasis (bold, italic, inline code)
- Unordered and ordered lists (including nested)
- Blockquotes, horizontal rules
- Fenced and indented code blocks with syntax highlighting (Pygments)
- Tables
- `mermaid` fenced code blocks, rendered to inline images

If a style is missing, the script reports the available styles and exits with a clear error.

## Adding Styles

Create a `.css` file in `agent-skills/skills/convert-md-to-pdf/styles/`; it becomes available as a `--style` option automatically.
