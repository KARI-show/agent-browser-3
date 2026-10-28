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
- browser_palette_harmony builds colour harmonies from one colour (default: the page's accent — its button, theme-color or link colour — against its background): complementary, split-complementary, analogous, triadic, tetradic, a tint ramp and a shade ramp, each with its WCAG contrast against the background, plus a :root variables block. Use it to pick a hover, button or accent colour that fits the site before writing an override or a custom theme.`,
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
  ],
};
