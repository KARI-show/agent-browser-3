---
title: Layout and spacing
summary: The 8-point spacing scale, grids, gutters, content widths, alignment and white space — how to measure what is off and the CSS that puts a page back on one scale.
when: things look cramped or uneven, misaligned or inconsistently spaced, when building or checking a section, checking a grid, fixing responsive breakage.
command: Fix the spacing and alignment on this page
prompt: Read the "layout" playbook with browser_skill_read, measure the page I am on (browser_overlay_grid and browser_overlay_measure if available, browser_style_inspect otherwise), list the spacing and alignment inconsistencies, and apply a minimal CSS fix that puts them on one scale. Show before and after.
icon: 📐
---
# Layout and spacing

Layout problems are measurable. Put everything on one spacing scale, align to one grid, give each width a reason, and the page calms down.

## The spacing scale

Use 4px as the unit and these steps: **4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96**. Everything — padding, margins, gaps, icon offsets — picks from the scale. A 13px or 27px gap is a mistake, not a nuance.

Proximity rule: space inside a group is smaller than the space between groups. A card with 16px padding needs at least 24px to its neighbour; a label sits 8px from its field and 24px from the next field.

| Element | Desktop | Mobile |
| --- | --- | --- |
| Page side padding | 32–48px | 16px |
| Section padding (top/bottom) | 64–96px | 48px |
| Card padding | 24px (16px for compact) | 16px |
| Gap between cards | = card padding | 12–16px |
| Label → input | 8px | 8px |
| Between form fields | 16–24px | 16px |
| Button height | 40px (36 compact, 44 touch) | 44px |
| Button horizontal padding | 1.5–2× the vertical padding | |
| Touch target | ≥ 44×44px | ≥ 44×44px |

## Widths

- Running text: `max-width: 65ch` (45–75 characters).
- Application content: 1200–1280px container; marketing pages 1140–1200px; documentation 760–820px for the text column.
- Images and media: `max-width: 100%; height: auto`, with explicit `width`/`height` attributes (or `aspect-ratio`) so nothing shifts while loading.

## The grid

12 columns, gutter 24px (16px on mobile), outer margins at least one gutter. Content aligns to column edges; a card's inner padding does not have to.

```css
.container { max-width: 1200px; margin-inline: auto; padding-inline: clamp(16px, 4vw, 48px); }
.grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 24px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; }
.stack > * + * { margin-top: var(--space, 16px); }
```

Draw the grid over the page (the overlay tool) and look at what lines up: text left edges, card edges, button edges. Each misaligned edge is one finding.

## Alignment

- Left-align text and controls in left-to-right languages; centre only short headlines, single labels and icons.
- One alignment per block. A centred headline above left-aligned body text is fine; a centred paragraph is not.
- Icons align to the text's x-height; use `display: inline-flex; align-items: center; gap: 8px` for icon + label.
- Numbers right-align in tables with `font-variant-numeric: tabular-nums`; headers align with their column.

## Corners, borders, elevation

- One radius family: 4/8/12 or 6/12/16 (small controls / cards / sheets). Nested radii: inner = outer − padding.
- Borders 1px in a colour 3:1 against the surface for interactive edges; dividers can be lighter.
- Elevation levels: 0 flat, 1 card (`0 1px 2px rgba(0,0,0,.06), 0 1px 3px rgba(0,0,0,.1)`), 2 popover, 3 modal. Shadows are for things that float; a grid of static cards does not need them.

## Responsive

- Breakpoints by content, not by device: common ones 640 / 768 / 1024 / 1280.
- Below 768: one column, side padding 16, section padding 48, buttons full width, tables scroll or stack.
- Nothing overflows horizontally at 320px (reflow); the primary action stays reachable with a thumb.
- Prefer `flex-wrap`, `auto-fit` grids and `clamp()` to many breakpoints.

## Measure, then fix

1. Inspect the elements that look off: margins, paddings, gaps, widths.
2. Measure the distances between sibling elements (the measure tool, or the inspected boxes). Off-scale numbers and unequal gaps between equal things are the findings.
3. Write the override at the container level where possible (one `gap` beats twelve margins), scoped to the section you measured.
4. Screenshot with the grid on to check alignment; then without it.

A typical fix:

```css
/* layout: one scale for the pricing section */
.pricing { padding-block: 80px; }
.pricing .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; }
.pricing .plan { padding: 24px; border-radius: 12px; }
.pricing .plan h3 { margin: 0 0 8px; }
.pricing .plan .price { margin-block: 16px 24px; }
```

## Checklist

- [ ] Every spacing value on the 4/8 scale; inner gaps smaller than outer
- [ ] Text measure 45–75ch; container widths justified
- [ ] Edges align to the grid; one alignment per block
- [ ] One radius family, consistent borders and elevation
- [ ] No horizontal overflow at 320px; touch targets ≥ 44px
