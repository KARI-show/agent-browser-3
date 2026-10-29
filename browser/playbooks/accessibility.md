---
title: Accessibility
summary: WCAG 2.2 AA in practice — contrast, visible focus, target size, text spacing, structure, forms, motion — what to check on a live page, how to report it, and the fixes CSS can carry.
when: asked about accessibility, a11y, WCAG, screen readers or keyboard use, or before shipping a restyle, theme or new component.
command: Check this page's accessibility
prompt: Read the "accessibility" playbook with browser_skill_read, check the page I am on by it (browser_palette_contrast if available, plus the page's structure from browser_read_page), report the failures by WCAG criterion with a fix for each, and apply the CSS-level fixes (focus ring, contrast, target size) if I ask.
icon: ♿
---
# Accessibility

Accessibility is a set of measurable requirements, not a vibe. Check the criteria below, report what fails with the criterion number, and separate what a style override can fix from what the site's developers must change.

## Contrast (1.4.3, 1.4.11)

- Body text 4.5:1 against its effective background; large text (≥24px, or ≥19px bold) 3:1.
- UI component boundaries, icons that carry meaning, and focus indicators 3:1 against adjacent colours.
- Placeholder text counts as text (it fails most often).
- Text over images or gradients: measure against the darkest and lightest part behind it, or add an overlay.
- Run the contrast tool; it approximates alpha and gradients, so confirm borderline cases by inspection.

## Focus (2.4.7, 2.4.11, 2.4.13)

- Every interactive element shows focus for keyboard users. `outline: none` without a replacement is a failure.
- A compliant ring: 2px solid, 2px offset, 3:1 against the background, not obscured by sticky headers.

```css
:focus-visible { outline: 2px solid #2f6fed; outline-offset: 2px; border-radius: 4px; }
:focus:not(:focus-visible) { outline: none; }
```

## Target size and spacing (2.5.8)

- Interactive targets at least 24×24px; 44×44px recommended on touch. Inline text links are exempt.
- Targets closer than 24px to each other need spacing or size.

## Text spacing and reflow (1.4.12, 1.4.10, 1.4.4)

- The layout must survive: line-height 1.5, paragraph spacing 2em, letter-spacing 0.12em, word-spacing 0.16em — nothing clipped, nothing overlapping. Fixed heights on text containers are the usual cause.
- Reflow at 320px wide without horizontal scrolling (except tables, maps, code).
- Zoom to 200% keeps everything usable; avoid `maximum-scale=1` in the viewport meta.

## Structure (1.3.1, 2.4.6, 2.4.1)

- One `h1`; heading levels do not skip (h2 → h4 is a failure); headings describe their sections.
- Landmarks: `header`, `nav`, `main`, `footer`, `aside` or their roles; a skip link to main content.
- Lists are lists, tables have header cells, buttons are `button` (not `div onclick`), links go somewhere (`href`).

## Images and media (1.1.1)

- Informative images have `alt` that says what matters; decorative ones have `alt=""`.
- Icon-only buttons have an accessible name (`aria-label`); SVG icons inside labelled buttons are `aria-hidden`.

## Links and buttons (2.4.4)

- Link text makes sense alone: "Download the report (PDF)", not "click here".
- Links navigate, buttons act; a button that looks like a link still needs a button's semantics.

## Forms (1.3.5, 3.3.1, 3.3.2)

- Visible labels associated with their fields (`for`/`id` or wrapping); placeholders are not labels.
- Required fields marked in text, not only by colour or an asterisk; `autocomplete` on personal data fields.
- Error messages next to the field, associated with `aria-describedby`, saying what to fix.

## Colour and motion (1.4.1, 2.3.3)

- Colour is never the only cue: add an icon, text or pattern (red border + message, not red border alone).
- Respect `prefers-reduced-motion`: no parallax, no auto-playing animation, transitions short.

```css
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; } }
```

## Language and titles (3.1.1, 2.4.2)

- `html lang` set and correct; the page `title` describes the page.

## Reporting

For each failure: the criterion (number and name), where (a selector or the visible text), the measured value, the fix, and who can fix it:

| Criterion | Where | Measured | Fix | Fixable by override? |
| --- | --- | --- | --- | --- |
| 1.4.3 Contrast | `.meta` grey captions | 3.2:1 | `color: #5f6368` | yes |
| 2.4.7 Focus visible | all buttons | no ring | `:focus-visible` ring | yes |
| 1.3.1 Headings | h2 → h4 under "Plans" | skipped level | change markup | no — site |

Style overrides can fix contrast, focus rings, target sizes and spacing. Missing labels, wrong roles, heading levels and alt text need the site's markup — report them clearly with the exact element so a developer can act.

## Checklist

- [ ] Text and UI contrast meet 4.5:1 / 3:1; placeholders included
- [ ] Focus visible on every control, 3:1, not obscured
- [ ] Targets ≥ 24px (44 on touch)
- [ ] Text spacing and 320px reflow survive
- [ ] One h1, no skipped levels, landmarks present
- [ ] Alt text, accessible names, link text that stands alone
- [ ] Labels, required marks and errors associated with fields
- [ ] Colour not the only cue; reduced motion respected; `lang` set
