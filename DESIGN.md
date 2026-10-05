---
name: Jev Router dashboard
description: A local, read-only page that shows which model each coding-CLI session was routed to, and the history behind it.
colors:
  canvas: "Canvas"
  canvas-text: "CanvasText"
  muted-text: "GrayText"
  hairline: "color-mix(in srgb, CanvasText 15%, transparent)"
  row-rule: "color-mix(in srgb, CanvasText 10%, transparent)"
  tier-haiku: "#2563eb"
  tier-sonnet: "#059669"
  tier-opus: "#d97706"
  tier-fable: "#7c3aed"
  error: "#dc2626"
typography:
  title:
    fontFamily: "-apple-system, \"Segoe UI\", sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "-apple-system, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  data:
    fontFamily: "-apple-system, \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "0.04em"
  tier-tag:
    fontFamily: "-apple-system, \"Segoe UI\", sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  md: "8px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  page:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.canvas-text}"
    typography: "{typography.body}"
    padding: "{spacing.xl}"
  panel:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.canvas-text}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  panel-heading:
    textColor: "{colors.muted-text}"
    typography: "{typography.label}"
  table-cell:
    textColor: "{colors.canvas-text}"
    typography: "{typography.data}"
    padding: "{spacing.xs} {spacing.sm}"
  tier-tag-haiku:
    textColor: "{colors.tier-haiku}"
    typography: "{typography.tier-tag}"
  tier-tag-sonnet:
    textColor: "{colors.tier-sonnet}"
    typography: "{typography.tier-tag}"
  tier-tag-opus:
    textColor: "{colors.tier-opus}"
    typography: "{typography.tier-tag}"
  tier-tag-fable:
    textColor: "{colors.tier-fable}"
    typography: "{typography.tier-tag}"
  notice-error:
    textColor: "{colors.error}"
    typography: "{typography.body}"
  notice-muted:
    textColor: "{colors.muted-text}"
    typography: "{typography.body}"
---

# Design System: Jev Router dashboard

The product name is being replaced, so "Jev Router" here is a placeholder, not a brand to build on (see PRODUCT.md).

## Overview

**Creative North Star: "The Flight Recorder"**

This is a log you can read, not a dashboard you are shown. It exists to answer, after the fact and at a glance, what the router decided and why, and to let the user take that record elsewhere. The record is the centre of the page: sessions as rows, decisions as counts, an export link beside them. Nothing on it is there to impress. The page is quiet because the thing being recorded is the interesting part.

Today the system is almost entirely borrowed. Surfaces and text take the browser's own colours, type is the operating system's UI font, structure is one-pixel translucent rules and a single corner radius, and there is no shadow and no motion. It reads as a native page of whichever browser and theme the user already has, which is correct for a tool that lives in a second tab next to a terminal. The confirmed direction for its components is **dense and technical**; the current implementation is plainer than that and has not yet been pushed there (see Components).

The one confirmed visual rejection is the generic SaaS analytics dashboard: oversized KPI cards, gradients, decorative charts, a product that performs "insight". It is rejected because this page records decisions and must stay trustworthy about what the data can and cannot say.

**Key Characteristics:**
- Borrowed from the system: colours, UI font, light and dark theme all follow the browser.
- Structure by hairline rules and one 8px radius; flat, no shadows, no motion.
- Four categorical tier hues plus one error red; tier is always written out, colour only reinforces.
- Tables and plain counts before any chart; the ledger is the content.

## Colors

A neutral, system-derived field with a small categorical set laid on top. There is no single brand accent; the only saturated colours encode data (which tier) or a fault (auth failed).

### Neutral
- **Canvas** (`Canvas`): page and panel background. A CSS system colour, so it is white in a light browser and near-black in a dark one. Never replaced by a hard-coded background.
- **Canvas Text** (`CanvasText`): body and data text.
- **Muted Text** (`GrayText`): panel headings, the subtitle, empty-state and "manual model selected" messages. Carries secondary information only.
- **Hairline** (`CanvasText` at 15% over transparent): the 1px panel border.
- **Row Rule** (`CanvasText` at 10% over transparent): the 1px divider under every table cell, lighter than the panel border so rows read as one table inside one panel.

### Tier hues (categorical)
These are generic saturated defaults (blue, emerald, amber and violet at the 600 step of a common palette), used only on the written tier name. Treat them as provisional: the identity is undecided and they were not chosen for this product.
- **Haiku Blue** (#2563eb): the fast tier.
- **Sonnet Green** (#059669): the balanced tier.
- **Opus Amber** (#d97706): the strong tier.
- **Fable Violet** (#7c3aed): the opt-in long tier.

### Status
- **Fault Red** (#dc2626): the only error colour; shown when the dashboard cannot authenticate.

### Named Rules
**The Borrowed Canvas Rule.** Background and text colours come from system colours (`Canvas`, `CanvasText`, `GrayText`), and every tint is derived from them with `color-mix`. A hard-coded page or panel colour breaks dark mode and the "looks like the user's own browser" promise.

**The Written Tier Rule.** A tier is always spelled out as uppercase text; its hue only reinforces. Colour never carries tier or status alone, so colour-blind users and monochrome displays lose nothing.

## Typography

**Display Font:** none. There is no display face.
**Body Font:** the operating system UI font (`-apple-system`, `"Segoe UI"`, then the generic `sans-serif`).
**Label/Mono Font:** none distinct. No monospace and no tabular-figure setting is used today.

**Character:** a single system face at four small sizes. Hierarchy comes from weight, case and tracking rather than from size jumps, which keeps the page compact and unremarkable by design.

### Hierarchy
- **Title** (700, 18px, 1.5): the one page heading.
- **Body** (400, 14px, 1.5): subtitle and messages.
- **Data** (400, 13px, 1.5): table cells and counts.
- **Label** (700 as the browser's default heading weight, 13px, +0.04em, uppercase): panel headings, set in Muted Text.
- **Tier tag** (600, 11px, uppercase): the tier name in session rows.

### Named Rules
**The One Face Rule.** One system family throughout. Introducing a web font or a second family adds a download and a brand voice this tool has not earned.

## Layout

One page, 24px of padding on all sides, a title and subtitle above a single auto-fitting grid of panels. The grid is `repeat(auto-fit, minmax(260px, 1fr))` with a 16px gap, so panels reflow from one column to as many as fit without any breakpoint. There are no media queries. Panel content runs on a 4px and 6px cell rhythm with a 12px gap under each panel heading.

Session rows truncate the prompt to one line at a 360px maximum with an ellipsis and carry the full text in a tooltip. How the four-column sessions table behaves in a narrow viewport has not been verified; it has no overflow handling of its own.

## Elevation & Depth

Flat. Depth is conveyed only by the 1px Hairline around each panel and the lighter Row Rule inside tables. There are no shadows, no layering and no blur, and no hover or focus treatment beyond the browser's defaults.

### Named Rules
**The Flat Rule.** Nothing floats. A shadow would suggest an interactive or ranked element on a page where every panel is equal.

## Shapes

One corner radius, 8px, on panels. Everything else is rectangular: table cells, tags and links have no radius, no fill and no border. Tier names are bare text, not pills.

## Components

All components are plain markup styled by a handful of rules; none has a variant system.

### Page and heading
- **Page:** system background and text, 24px padding.
- **Title:** 18px bold, 4px below, no decoration.
- **Subtitle:** Muted Text, 24px below. Also carries the export links and, on failure, is replaced by the Fault Red authentication message.

### Panels
- **Corner Style:** 8px.
- **Background:** Canvas, the same as the page; panels are outlined, not filled.
- **Border:** 1px Hairline.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Internal Padding:** 16px, with an uppercase Muted Text heading 12px above the content.

### Sessions table
- **Style:** full-width, collapsed borders, 13px, each cell 4px by 6px with a Row Rule underneath. A header row sits above the data rows.
- **Columns:** session id, tier tag, confidence as a whole percentage, prompt (one line, ellipsis).
- **Manual sessions:** one muted italic cell reading "manual model selected" spans the data columns.
- **Empty and loading:** a muted italic single cell.

### Tier tag
- **Style:** 11px, 600, uppercase, the tier's hue on the page background. No fill, border or radius.

### Count rows
- **Style:** a flex row, label left and bold count right, 2px of vertical padding, ordered by descending count. Used for decisions by tier and by CLI. No bars or charts.

### Export links
- **Style:** the browser's default link appearance, inline in the subtitle, separated by a middle dot.

### Direction not yet in the code
The confirmed intent is **dense and technical**. Today the components are plain and generous, not dense: rows are not tightened, figures are not set to align, and counts are not visualised. Treat "dense and technical" as the target for the next pass and "plain and system-native" as the current reality; do not describe the present page as already dense.

## Do's and Don'ts

### Do:
- **Do** take every surface and text colour from `Canvas`, `CanvasText` and `GrayText`, and derive tints with `color-mix` (15% for a panel border, 10% for a row rule).
- **Do** write the tier name out in uppercase wherever a tier hue appears.
- **Do** keep the page flat: 1px rules, one 8px radius, no shadows and no motion.
- **Do** keep tables and plain counts as the primary way data is shown; add a chart only where a distribution cannot be read from the counts, and label it with exactly what the ledger holds.
- **Do** keep export and prompt text separate: the page may show a truncated prompt; the export never contains one.

### Don't:
- **Don't** turn it into a generic SaaS analytics dashboard: oversized KPI cards, gradients, decorative charts, an "insights" voice.
- **Don't** hard-code a page or panel background or text colour; it breaks the dark theme and the native look.
- **Don't** let colour alone carry tier or status.
- **Don't** introduce a web font, an icon font or any external asset; the page is one self-contained file.
- **Don't** show cost, savings or accuracy figures the ledger cannot support (PRODUCT.md).

### Known gaps (measured)
Contrast of the tier hues against the system background, for the 11px bold tier tag (small text needs 4.5:1):

| Hue | on white | on dark `#121212` (browser-dependent) |
|---|---|---|
| Haiku Blue | 5.17 | 3.62 (fails) |
| Sonnet Green | 3.77 (fails) | 4.97 |
| Opus Amber | 3.19 (fails) | 5.88 |
| Fable Violet | 5.70 | 3.29 (fails) |
| Fault Red | 4.83 | 3.88 (fails) |

Each hue fails in at least one theme. The written tier name keeps the information available, but the text itself is under-contrast in those cases. There is also no custom focus style for the export links, and the table's behaviour on narrow screens is unverified.
