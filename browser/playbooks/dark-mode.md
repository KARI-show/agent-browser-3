---
title: Dark theme
summary: Convert a light site to a dark theme that stays legible and on-brand — surface levels instead of shadows, text at 87/60/38 percent, brightened accents, untouched images — and fix the usual leftovers.
when: the user wants a dark mode or night theme for a site, or a generated dark theme looks wrong (grey mush, glowing images, unreadable links, white boxes).
command: Dark theme for this site
prompt: Read the "dark-mode" playbook with browser_skill_read, extract the palette of the page I am on, apply a dark theme (browser_palette_theme dark if available, otherwise write the override by the playbook with browser_style_apply), take a screenshot and fix the leftovers the playbook lists (images, borders, links, form fields, inline-styled boxes).
icon: 🌙
---
# Dark theme

Dark mode is not inverted light mode. It is a new set of surfaces, text opacities and accent brightnesses that keep the brand's hue and the content's hierarchy. Images, logos and illustrations stay as they are.

## Surfaces

- Base surface `#121212`–`#16181d`, never pure black (pure black makes every edge harsh and halos text). Tint it 2–4% toward the brand hue (a blue brand: `#13161c`; a warm brand: `#171412`).
- Elevation is lightness, not shadow. Each level lifts the surface: level 1 (cards) +4–5% lightness, level 2 (menus, popovers) +7%, level 3 (dialogs) +9–11%. Example from `#16181d`: cards `#1e2128`, popovers `#24272f`, dialogs `#2a2e37`.
- Borders at `rgba(255,255,255,.12)`; dividers at `.08`. Shadows become borders or a faint lighter outline.
- `color-scheme: dark` on `:root` so form controls, scrollbars and the default focus ring switch too.

## Text

| Role | Colour |
| --- | --- |
| Primary text | `rgba(255,255,255,.87)` (≈ `#e3e3e3`) |
| Secondary / muted | `rgba(255,255,255,.60)` |
| Disabled, placeholders | `rgba(255,255,255,.38)` |
| Headings | same as primary; weight carries hierarchy |

Never pure white body text: it vibrates against dark surfaces. Large bold headings may go to `.95`.

## Accents and semantic colours

Brand colours tuned for white backgrounds are too dark and too saturated on dark surfaces.

- Lighten the accent until it reaches 4.5:1 on the base surface and desaturate it 10–20%. `#1a73e8` → `#8ab4f8`; `#e0457b` → `#f27ca3`; `#0f9d58` → `#6ad39a`.
- Primary button: either the lightened accent with dark text (`#0e1116` on `#8ab4f8`) or the original accent darkened for a surface and light text — pick the one that passes contrast; keep it consistent.
- Links: the lightened accent, underlined in running text.
- Semantic colours: success `#6ad39a`, warning `#f5c35a`, danger `#f28b82`, with tinted dark backgrounds (`rgba(colour, .15)`) for notices.

## Images and media

- Never `filter: invert()` on the page. It ruins photos, logos and flags.
- Dim photos slightly: `img { filter: brightness(.9) }` (not icons; target content images by container).
- Logos on a white plate: give the plate the level-1 surface and padding, or leave the white if the logo needs it.
- SVG icons using `currentColor` follow the text colour; icons with hard-coded fills need a `fill` override.

## Mapping a light palette

From the extracted palette, map the most frequent colours:

| Light | Dark |
| --- | --- |
| Page background (white / off-white) | base surface |
| Card / panel background | level 1 |
| Body text (near-black) | `rgba(255,255,255,.87)` |
| Muted text (grey) | `rgba(255,255,255,.60)` |
| Borders (light grey) | `rgba(255,255,255,.12)` |
| Accent | lightened, desaturated accent |
| Shadows | borders or a lighter level |

## The override

```css
/* theme:dark */
:root { color-scheme: dark; }
html, body { background: #16181d !important; color: rgba(255,255,255,.87) !important; }
main, article, section, header, footer, nav, aside, div { background-color: transparent; }
.card, .panel, [class*="card"], [class*="panel"] { background-color: #1e2128 !important; border-color: rgba(255,255,255,.12) !important; box-shadow: none !important; }
h1, h2, h3, h4, h5, h6 { color: rgba(255,255,255,.92) !important; }
p, li, td, th, label, span { color: inherit; }
a { color: #8ab4f8 !important; }
hr, [class*="divider"] { border-color: rgba(255,255,255,.08) !important; }
input, textarea, select { background-color: #1e2128 !important; color: rgba(255,255,255,.87) !important; border: 1px solid rgba(255,255,255,.2) !important; }
button, [role="button"] { border-color: rgba(255,255,255,.2); }
img:not([src$=".svg"]) { filter: brightness(.9); }
::selection { background: rgba(138,180,248,.35); }
```

Replace the class guesses with the selectors you inspected on the actual page; `!important` is needed where the site sets colours inline or late. Keep the rule list short and specific — a dark theme that restyles every `div` becomes slow and brittle.

## Leftovers to check on the screenshot

1. **White boxes** — elements with inline `style="background: #fff"` or backgrounds set on unusual tags; add their selectors.
2. **Gradients and hero images** with dark text on them — give the text a light colour or a dark overlay.
3. **Grey-on-grey** — muted text that was `#777` on white is now `#777` on dark; re-map to `.60` white.
4. **Form fields** still white; **placeholders** invisible.
5. **Code blocks** with a light theme — switch their background to level 1 and keep syntax colours readable.
6. **Icons** with hard-coded dark fills; **borders** that disappeared (were `#eee`).
7. **Focus ring** invisible — set `outline-color` to the lightened accent.

Run the contrast check after the theme: text at `.87` on `#16181d` is 13:1; the failures will be in the leftovers.

## Checklist

- [ ] Base surface not pure black, tinted toward the brand hue
- [ ] Elevation by lighter surfaces; shadows gone or faint
- [ ] Text at .87 / .60 / .38; no pure white body text
- [ ] Accent lightened and desaturated; links readable; buttons pass contrast
- [ ] Images not inverted; photos dimmed slightly
- [ ] `color-scheme: dark`; form fields, placeholders, focus ring handled
