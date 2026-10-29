import { z } from "zod";
import type { ExtraFeature } from "./types";

/**
 * Palette: what the page is made of (colours, fonts, spacing), WCAG contrast, and themes built on
 * the extracted palette and applied through the styles extra's overrides (the brand needs styles,
 * see browser/brand.mjs FEATURE_REQUIRES). browser/extras/palette.js implements the tools in the
 * side panel and adds the 🧪 Palette tab and the "Design" quick commands.
 */
export const palette: ExtraFeature = {
  id: "palette",
  prompt: `## Palette
- browser_palette_extract reads what the page is made of: text, background and border colours with counts, font families with their sizes and weights (the type scale), the most common spacings, the theme colour and the colour variables on :root. Use it to answer "what colours / fonts does this site use", to pick colours that fit the site before writing an override, and before building a theme; as="css" gives the colours as CSS variables to paste.
- browser_palette_contrast checks the visible text against WCAG 2 AA (4.5:1, 3:1 for large text) and lists the failing styles with the text, the ratio, a selector and both colours. Fix one with a browser_style_apply rule for that selector and check again; ratios over background images are approximate.
- browser_palette_theme builds a dark, sepia, high-contrast or custom theme from the extracted palette — the common backgrounds and text colours are mapped to counterparts and color-scheme is set; it is not an invert filter, so images stay as they are — and saves it as the site's "theme:<mode>" override (persistent, listed by browser_style_list and in the 🎨 tab). One theme per site: a new one replaces the earlier; preview=true applies it without saving; mode="off" removes the site's theme.
- browser_palette_harmony builds colour harmonies from one colour (default: the page's accent — its button, theme-color or link colour — against its background): complementary, split-complementary, analogous, triadic, tetradic, a tint ramp and a shade ramp, each with its WCAG contrast against the background, plus a :root variables block. Use it to pick a hover, button or accent colour that fits the site before writing an override or a custom theme.
- browser_palette_tokens lists the page's design tokens — the CSS custom properties its stylesheets declare (a cross-origin stylesheet cannot be read and is counted), grouped into colours, lengths, fonts and other with the resolved value, where each is declared and how many rules use it, the 40 most used first; change one everywhere with browser_style_tokens. browser_palette_recolor swaps one colour for another across the visible page: the elements whose text, background and/or border colour lies within a tolerance of the colour get minimal selectors and the override "Recolor <from>→<to>" sets them to the new one — for a brand colour the site does not keep in a token; check with a screenshot and fix a missed spot with browser_style_apply. browser_palette_from_image takes the dominant colours of an image (the largest visible one, or a ref / selector) by median cut, with their share and contrast against the page background and a :root block — only a same-origin or CORS-enabled image can be read; when the canvas is tainted it says so: open the image and describe it from a screenshot instead.`,
  tools: [
    {
      name: "browser_palette_extract",
      feature: "palette",
      readOnly: true,
      description:
        "Extract the page's palette (top frame, up to ~3000 visible elements sampled): text, background and " +
        "border colours with counts (as hex, alpha dropped unless transparent) and the selectors that use " +
        "them most, font families with counts and their sizes/weights as a type scale, the most common " +
        "margins and paddings (rounded to 4px), the <meta name=theme-color>, the colour variables on :root, " +
        "and the body, link and button colours. Returns a readable report with a block of CSS variables; " +
        "as='css' returns only the variables, as='json' the raw summary.",
      shape: {
        as: z.enum(["report", "css", "json"]).optional().describe("Output form (default report)"),
      },
    },
    {
      name: "browser_palette_contrast",
      feature: "palette",
      readOnly: true,
      description:
        "Check the WCAG 2 contrast of the visible text in the current tab (top frame): each text style's " +
        "colour against its effective background (the first non-transparent background up the tree, " +
        "semi-transparent layers blended), lists the failures under AA (4.5:1 for normal text, 3:1 for " +
        "large text: 24px, or 18.66px bold) with the text snippet, the ratio, a selector and both colours, " +
        "and counts the passes. level='AAA' checks 7:1 / 4.5:1 instead.",
      shape: {
        level: z.enum(["AA", "AAA"]).optional().describe("Conformance level to check against (default AA)"),
        selector: z.string().optional().describe("Only text inside the elements this selector matches (default: the whole page)"),
      },
    },
    {
      name: "browser_palette_theme",
      feature: "palette",
      readOnly: false,
      description:
        "Build a theme for the current site from its extracted palette and save it as the site's style " +
        "override 'theme:<mode>' (one theme per site; an earlier theme is replaced), applied at once and kept " +
        "on every later visit. dark: color-scheme dark, the common light backgrounds mapped to dark surfaces " +
        "and dark text to light text, links and buttons kept in the site's hue but brightened — no invert " +
        "filter, images stay as they are. sepia: warm paper tones. high-contrast: black, white and yellow " +
        "links. custom: the same structure from the colours in `overrides`. preview=true applies without " +
        "saving (until the page reloads); mode='off' removes the site's theme.",
      shape: {
        mode: z.enum(["dark", "sepia", "high-contrast", "custom", "off"]).describe("Which theme to build (off removes the site's theme)"),
        name: z.string().optional().describe("Override name (default 'theme:<mode>')"),
        overrides: z
          .record(z.string(), z.string())
          .optional()
          .describe("mode=custom: colour tokens — bg, surface, text, muted, link, accent, accentText, border (hex or rgb()); scheme: 'dark' | 'light'"),
        preview: z.boolean().optional().describe("Apply in the current tab without saving (default false)"),
        site: z.string().optional().describe("Host the theme belongs to (default: the current tab's)"),
      },
    },
    {
      name: "browser_palette_harmony",
      feature: "palette",
      readOnly: true,
      description:
        "Colour harmonies of a colour, as hex: complementary, split-complementary (2), analogous (2, ±30°), " +
        "triadic (2), tetradic (3), a tint ramp (5 steps toward white) and a shade ramp (5 steps toward black), " +
        "each with its WCAG 2 contrast ratio against the background (✓ AA at 4.5:1 for text, ⚠ below it, with " +
        "the 3:1 large-text/UI mark), plus a ready :root { --accent… } variables block. Without color it takes " +
        "the current page's accent (its button background, theme-color or link colour, whichever stands out); " +
        "without background, the page's body background.",
      shape: {
        color: z.string().optional().describe("The base colour: hex, rgb() or hsl() (default: the page's accent)"),
        background: z.string().optional().describe("The background the ratios are measured against (default: the page's background)"),
      },
    },
    {
      name: "browser_palette_tokens",
      feature: "palette",
      readOnly: true,
      description:
        "List the page's design tokens: the CSS custom properties (--name) declared in its stylesheets — every " +
        "readable rule, @media and co. included; a cross-origin stylesheet cannot be read and is counted as " +
        "unreadable — and in the style attribute of html/body, each with its value resolved on :root/body (the " +
        "declared value where it does not resolve), where it is declared, and how many var(--name) uses the " +
        "readable rules make of it; grouped into colours, lengths, fonts and other, the 40 most used first. " +
        "Call it before browser_style_tokens to find the token behind a colour, a spacing or a font.",
      shape: {
        filter: z.string().optional().describe("Only tokens whose name contains this text, e.g. 'color' or 'brand' (default: all)"),
      },
    },
    {
      name: "browser_palette_recolor",
      feature: "palette",
      readOnly: false,
      description:
        "Replace one colour with another across the current tab: the visible elements (top frame, up to ~3000 " +
        "sampled) whose text colour, background colour and/or border colour lies within tolerance of `from` " +
        "(a 0–100 distance in sRGB: 0 the exact colour, 12 by default, 40 catches neighbouring shades) get " +
        "minimal selectors (an id, or the tag with its stable classes; de-duplicated, at most 60), and the " +
        "override 'Recolor <from>→<to>' sets the matched properties to `to` with !important — saved for the " +
        "site and applied at once. Returns the elements, shades and selectors matched and the override's size; " +
        "nothing is saved when nothing matches (the closest colour is named). For a colour the site keeps in " +
        "a custom property, browser_style_tokens is the cleaner change. Check the result with browser_screenshot.",
      shape: {
        from: z.string().describe("The colour to replace: hex, rgb() or hsl()"),
        to: z.string().describe("The new colour: hex, rgb() or hsl()"),
        tolerance: z.number().min(0).max(40).optional().describe("How far from `from` a colour may be and still match, 0–40 (default 12)"),
        properties: z.array(z.enum(["color", "background", "border"])).optional().describe("Which properties to match and set (default all three)"),
        site: z.string().optional().describe("Host the override belongs to (default: the current tab's)"),
      },
    },
    {
      name: "browser_palette_from_image",
      feature: "palette",
      readOnly: true,
      description:
        "The dominant colours of an image on the page: the element (a ref from browser_read_page, a CSS " +
        "selector, or by default the largest visible <img> or element with a background-image) is drawn on a " +
        "canvas in the page, its pixels (at most 64 px on the long side, transparent ones dropped) are quantised " +
        "by median cut, and the top `count` colours come back as hex with their share, their hue/saturation/" +
        "lightness and their WCAG contrast against the page background, plus a :root { --image-1… } block. " +
        "Only a same-origin or CORS-enabled image can be read: a tainted canvas is reported as such — then " +
        "open the image URL and describe it from a screenshot instead.",
      shape: {
        ref: z.number().int().min(1).optional().describe("Element ref from the latest browser_read_page (an <img>, or an element with a background-image)"),
        selector: z.string().optional().describe("CSS selector instead of a ref (the first match, top frame)"),
        count: z.number().int().min(2).max(8).optional().describe("How many colours to return, 2–8 (default 5)"),
      },
    },
  ],
};
