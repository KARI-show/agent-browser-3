---
title: Colour and palette
summary: Build and judge a palette — one accent, a neutral ramp, semantic colours, contrast targets — and extend a site's own colours instead of replacing them.
when: picking or changing colours, building a palette or CSS variables, the page looks garish or flat, a brand colour question, accessible links and buttons, hover and focus colours.
command: Tune this page's colours
prompt: Read the "color" playbook with browser_skill_read, extract the palette of the page I am on (browser_palette_extract if available), judge it by the playbook, propose a tightened palette as CSS variables, apply the minimal override that fixes the worst issues (browser_style_apply if available) and check contrast afterwards.
icon: 🎨
---
# Colour and palette

A palette is a system, not a list of colours: one accent that means "act here", a neutral ramp that carries everything else, and a few semantic colours that carry meaning. Start from what the site already has.

## Proportions

- **60 / 30 / 10**: neutral surfaces 60%, secondary neutrals and text 30%, accent 10% or less.
- The accent marks actions and the current state (primary button, active tab, links, focus ring). Decorative use of the accent dilutes it; if an icon, a divider and a badge are all accent-coloured, the button no longer stands out.
- One filled primary button per view. Secondary actions are outlined or plain text in the ink colour.

## Building ramps

Work in HSL or OKLCH, not by eyeballing hex codes.

- **Tints** (lighter): raise lightness in ~8–10% steps and drop saturation a little each step, otherwise light tints turn neon.
- **Shades** (darker): lower lightness in ~8% steps; nudge the hue a few degrees toward blue for cool colours and toward red for warm ones so shades stay rich instead of muddy.
- A ramp of 9 steps (50–900) covers backgrounds (50–100), borders (200–300), icons (500), text (700–900).

### Neutrals

- Never pure black for text: `#1a1a1a`–`#222` or an ink tinted toward the accent hue (for a blue brand, `#1b2432`).
- Never pure white for large surfaces when the brand is warm: `#fbfaf7`; keep pure white for cards that must lift off the background.
- Grey text that passes 4.5:1 on white is darker than it looks: `#5f6368` passes, `#8a8a8a` fails.

### Semantic colours

Success, warning, danger and info need hues clearly apart from the accent (a blue accent with a blue info colour confuses). Each gets a text shade, a border shade and a background tint. Colour is never the only cue: pair it with an icon or a word.

## Contrast targets

| Case | Minimum |
| --- | --- |
| Body text | 4.5:1 |
| Large text (≥24px, or ≥19px bold) | 3:1 |
| UI component edges, icons, focus rings | 3:1 against adjacent colours |
| Link in running text vs. surrounding text | 3:1 and an underline or weight change |

Check with the contrast tool when the build has one; otherwise compute it. White text on a mid-tone accent (for example `#ff6b57`) often fails — darken the button or use dark text.

## Interactive colours

```css
:root {
  --c-bg: #fbfaf7;
  --c-surface: #ffffff;
  --c-text: #1f2328;
  --c-muted: #5f6368;
  --c-border: #e3e1dc;
  --c-accent: #2f6fed;
  --c-accent-hover: #255cc8;   /* ~8% darker */
  --c-accent-active: #1f4ea8;  /* ~12% darker */
  --c-on-accent: #ffffff;
  --c-focus: #2f6fed;
}
button.primary:hover { background: var(--c-accent-hover); }
button.primary:active { background: var(--c-accent-active); }
:focus-visible { outline: 2px solid var(--c-focus); outline-offset: 2px; }
button:disabled { opacity: .45; cursor: not-allowed; }
```

- Hover darkens ~8%, active ~12% (on dark themes: lighten instead).
- Focus is a 2px ring with 2px offset, 3:1 against the background; never `outline: none` without a replacement.
- Links: accent colour in text, underlined; visited may be a shade darker.

## Working on a live site

1. Extract the palette (colours by frequency, fonts, CSS custom properties on `:root`). The most frequent background and text colours are the base; the most frequent saturated colour is the de-facto accent.
2. Judge: more than one saturated colour competing for "action"? Grey text under 4.5:1? Pure black on pure white (harsh)? Semantic colours missing or colliding with the accent?
3. Propose a tightened palette as variables, mapped from the site's own colours (keep their hue; fix lightness and saturation).
4. Apply the smallest override: usually the muted text colour, the link colour, the primary button, hover/focus. Leave logos, photos and illustrations alone.
5. Re-check contrast and screenshot.

## Dark counterpart

A palette needs a dark version before it is finished: surfaces around `#121212`–`#16181d` tinted toward the brand hue, text at 87% / 60% white, accents lightened and slightly desaturated until they pass 4.5:1 on the dark surface. The dark-mode playbook has the full recipe.

## Checklist

- [ ] One accent, used for actions; one filled primary per view
- [ ] Neutral ramp: no pure black text, muted text passes 4.5:1
- [ ] Semantic colours distinct from the accent, never the only cue
- [ ] Hover / active / focus / disabled defined
- [ ] Links distinguishable in text
- [ ] Variables named by role (`--c-accent`), not by colour (`--blue`)
