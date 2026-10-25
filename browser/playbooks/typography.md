---
title: Typography
summary: The numbers that make text read well — size, line-height, measure, scale, hierarchy, pairing — and the CSS that fixes a page's type without replacing its fonts.
when: text is hard to read, headings and body do not relate, there are too many font sizes or weights, the user asks to fix fonts, pick a type scale, or pair typefaces.
command: Fix the typography on this page
prompt: Read the "typography" playbook with browser_skill_read, inspect the body text and the headings of the page I am on (browser_style_inspect if available), name what breaks the playbook's rules, and apply a minimal CSS fix that keeps the site's own fonts (browser_style_apply if available). Show before and after.
icon: 🔤
---
# Typography

Good type is mostly arithmetic: a body size that reads, a line-height that breathes, a measure the eye can track, and a small scale that every size comes from. Keep the site's typefaces; fix the numbers.

## The numbers

| Property | Target | Notes |
| --- | --- | --- |
| Body size | 16–18px on the web; 14–15px only in dense data UIs | Below 16px on mobile, iOS zooms form fields |
| Body line-height | 1.5–1.65 | Longer lines and lighter weights need more |
| Heading line-height | 1.1–1.25 | Tighter as the size grows |
| Measure (line length) | 45–75 characters, 66 is ideal | `max-width: 65ch` on the text container |
| Paragraph spacing | 0.75–1em | Either spacing or first-line indents, never both |
| Heading spacing | `margin-top: 1.5–2em; margin-bottom: 0.5em` | Headings belong to the text below them |
| Sizes on one page | 5–6 | More than that reads as noise |
| Weights on one page | 2–3 (for example 400, 600, 700) | |
| Large heading tracking | −0.01 to −0.02em | Display sizes look loose otherwise |
| Uppercase label tracking | +0.05 to +0.1em, 11–13px, weight 600 | Never uppercase running text |

## A type scale

Pick one ratio and derive every size from the body size. 1.2 (minor third) suits dense interfaces, 1.25 (major third) marketing and documentation, 1.333 (perfect fourth) a landing hero.

With body 16px and ratio 1.25: 12.8 · 16 · 20 · 25 · 31 · 39 · 49. Round to whole pixels and give each a role (caption, body, lead, h4, h3, h2, h1). For responsive headings use `clamp()`:

```css
h1 { font-size: clamp(1.75rem, 1.2rem + 2vw, 3rem); }
```

## Hierarchy

Hierarchy comes from size, weight and colour — use two of the three per level, not all three everywhere. Muted text is a darker grey than designers expect: on white, `#5f6368` passes 4.5:1, `#999` does not. Captions and metadata at 0.875em, one step lighter, never under 12px.

## Pairing

- The safest pairing is one family with several weights.
- When pairing two, contrast their structure (a humanist sans with a transitional serif) and match their x-height and overall colour on the page; let one of them do headings only.
- Never more than two families plus a monospace for code.
- Always give a fallback stack so the layout survives a slow web font:

```css
font-family: "SiteFont", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
```

## Details that show craft

- `font-variant-numeric: tabular-nums` in tables and anywhere numbers align.
- Real quotes and dashes in copy; `text-wrap: balance` on headings, `text-wrap: pretty` on paragraphs where supported.
- No justified text on the web (rivers); no widows in headings when `balance` is available.
- Underline links in running text (`text-underline-offset: 0.15em; text-decoration-thickness: 1px`).
- `-webkit-font-smoothing` is not a fix for a thin weight; pick a heavier weight.

## Inspect, then fix

1. Inspect the body paragraph and each heading level: size, line-height, weight, colour, measure (container width ÷ (size × 0.5) ≈ characters per line).
2. Compare to the table above; list every miss.
3. Write the smallest override that puts the page on a scale. A typical readability fix:

```css
/* typography: scale and measure */
body { font-size: 17px; line-height: 1.6; }
main, article { max-width: 68ch; margin-inline: auto; }
h1 { font-size: 2.25rem; line-height: 1.15; letter-spacing: -0.015em; }
h2 { font-size: 1.6rem; line-height: 1.2; margin-top: 1.75em; margin-bottom: .5em; }
h3 { font-size: 1.25rem; line-height: 1.3; }
p + p { margin-top: .9em; }
small, .caption { font-size: .875rem; }
```

Scope the selectors to the content container you inspected instead of `body` when the site's navigation would be affected.

## Checklist

- [ ] Body 16–18px, line-height 1.5–1.65, measure 45–75ch
- [ ] At most 6 sizes from one ratio, at most 3 weights
- [ ] Headings tight, tracked slightly negative when large; labels tracked positive
- [ ] Muted text still passes 4.5:1
- [ ] Links in text are visibly links
- [ ] Fallback font stack present; no justified text
