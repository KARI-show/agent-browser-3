---
title: Components on any page
summary: Drop-in HTML and CSS for banners, notices, buttons, badges, cards, notes and toasts that inherit the host site's look, work without scripts, and never fight the page.
when: adding an element to a page (a banner, note, button, badge, card, toast), mocking up a change, or when an added component looks alien on the host site.
command: Add a component to this page
prompt: Read the "components" playbook with browser_skill_read, ask me what to add if it is not clear (or propose a banner), take the host page's font and colours (browser_palette_extract or browser_style_inspect if available), and add the component with browser_element_add using the playbook's patterns. Screenshot to check it at the page's width.
icon: 🧱
---
# Components on any page

An added component should look like the site made it. It inherits the host's type and colour, sits on the host's spacing scale, works without JavaScript (added fragments are static: no scripts, no event handlers), and stays out of the way of anything important.

## Principles

- **Inherit**: `font: inherit; color: inherit; line-height: inherit`. Take the accent from the host (its link or button colour) rather than inventing one.
- **Scale**: sizes in `em`/`rem`; paddings from the 4/8 scale; radius from the host's family (inspect a host button).
- **Contrast**: 4.5:1 for text, 3:1 for borders and the dismiss control.
- **Layering**: fixed components use `z-index: 2147483000` (below the extension's own overlays), honour safe areas (`env(safe-area-inset-bottom)`), and never cover consent dialogs, login, checkout or error messages.
- **No scripts**: dismissal uses the checkbox pattern below; links are plain `href`s.
- **Scoped CSS**: every rule starts with the component's generated id so nothing leaks into the page. Width check at 375px as well as desktop.

## Dismiss without JavaScript

```html
<input type="checkbox" id="agent-x-close" hidden>
<div class="agent-x">
  … content …
  <label for="agent-x-close" class="agent-x-dismiss" aria-label="Dismiss" title="Dismiss">✕</label>
</div>
```

```css
#agent-x-close:checked ~ .agent-x { display: none; }
.agent-x-dismiss { cursor: pointer; padding: .25em .5em; border-radius: .25em; opacity: .7; }
.agent-x-dismiss:hover, .agent-x-dismiss:focus-within { opacity: 1; }
```

The checkbox must precede the component as a sibling.

## 1. Top banner

```html
<div class="agent-banner" role="region" aria-label="Notice">
  <strong>Heads up:</strong> <span>Maintenance on Saturday 02:00–04:00 UTC.</span>
  <a href="#details">Details</a>
</div>
```

```css
.agent-banner { position: sticky; top: 0; z-index: 2147483000; display: flex; gap: .75em; align-items: center; justify-content: center; flex-wrap: wrap; padding: .75em 1em; background: #fff8e1; color: #3d2e00; border-bottom: 1px solid #f0d78c; font: inherit; font-size: .95em; }
.agent-banner a { color: inherit; font-weight: 600; text-decoration: underline; }
```

Use `position: sticky` on an element inserted as the first child of `body` so it pushes content instead of covering it; `fixed` covers the header — avoid it unless the host header is not sticky.

## 2. Inline notice

```html
<div class="agent-notice" role="status">
  <strong>Tip</strong> — Annual billing saves two months.
</div>
```

```css
.agent-notice { margin: 1em 0; padding: .75em 1em; border-left: 4px solid currentColor; border-radius: .375em; background: rgba(0,0,0,.04); color: inherit; }
```

Semantic variants: info `#0b5fa5`, success `#1b7f3b`, warning `#8a5a00`, danger `#b3261e` as the border colour with a matching 8% tint background.

## 3. Call-to-action button

```html
<a class="agent-cta" href="https://example.com/start">Start free trial</a>
```

```css
.agent-cta { display: inline-flex; align-items: center; gap: .5em; min-height: 2.75em; padding: .75em 1.5em; border-radius: .5em; background: #2f6fed; color: #fff; font: inherit; font-weight: 600; text-decoration: none; }
.agent-cta:hover { filter: brightness(.92); }
.agent-cta:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
```

Replace `#2f6fed` with the host's accent; one filled CTA per view.

## 4. Badge / pill

```html
<span class="agent-badge">New</span>
```

```css
.agent-badge { display: inline-block; padding: .15em .6em; border-radius: 999px; font: inherit; font-size: .75em; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; background: #e8f0fe; color: #1a4fb3; vertical-align: middle; }
```

## 5. Card

```html
<article class="agent-card">
  <h3>Pro plan</h3>
  <p>Up to 5 seats, shared recipes, priority support.</p>
  <a href="#pro">Choose Pro</a>
</article>
```

```css
.agent-card { padding: 1.5em; border: 1px solid rgba(0,0,0,.12); border-radius: .75em; background: #fff; color: inherit; max-width: 28em; }
.agent-card h3 { margin: 0 0 .5em; font-size: 1.125em; }
.agent-card p { margin: 0 0 1em; opacity: .85; }
```

## 6. Sticky note (bottom-right)

```html
<aside class="agent-note" role="note">
  <strong>Reviewer's note</strong>
  <p>The hero CTA is below the fold on a 13" laptop.</p>
</aside>
```

```css
.agent-note { position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 2147483000; max-width: 320px; padding: 1em 1.25em; border-radius: .75em; background: #fff9c4; color: #3a3000; box-shadow: 0 8px 24px rgba(0,0,0,.18); font: inherit; font-size: .95em; }
.agent-note strong { display: block; margin-bottom: .25em; }
.agent-note p { margin: 0; }
@media (max-width: 480px) { .agent-note { left: 16px; right: 16px; max-width: none; } }
```

## 7. Toast

```css
.agent-toast { position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 2147483000; padding: .75em 1.25em; border-radius: .5em; background: #1f2328; color: #fff; font: inherit; font-size: .95em; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
```

A toast with no script cannot time out; pair it with the dismiss pattern or use it only for screenshots.

## Fitting the host

1. Inspect a host button and a host card: font size, radius, border colour, accent. Copy those numbers into the component's CSS.
2. Place the component where its kind belongs: banners first in `body`, notices near the content they refer to, CTAs where the decision happens.
3. Screenshot at desktop and 375px; check nothing important is covered and the dismiss control works (it is a label, so a click toggles the hidden checkbox).
4. Name the element after its purpose so the user recognises it in the list of the site's edits, and remind them the site keeps it until it is forgotten.

## Checklist

- [ ] Inherits font and colour; accent from the host
- [ ] Scoped CSS; sizes in em/rem; radius from the host's family
- [ ] No scripts; dismiss via the checkbox pattern
- [ ] Covers nothing important; safe areas honoured; z-index below overlays
- [ ] Checked at desktop and 375px
