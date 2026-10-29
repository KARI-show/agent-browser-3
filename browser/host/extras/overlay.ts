import { z } from "zod";
import type { ExtraFeature } from "./types";

/**
 * Layout overlays for design review: a column/baseline grid, measurements between two elements and
 * numbered review notes, all drawn in one click-through layer on the page for this visit only (nothing
 * is saved). browser/extras/overlay.js implements the tools in the side panel and adds the 📐 Overlay
 * tab and its "Design" quick commands.
 */
const ref = z.number().int().min(1).describe("Element ref number from the latest browser_read_page");
const selector = z.string().describe("Or a CSS selector of the element (top frame, first match)");

export const overlay: ExtraFeature = {
  id: "overlay",
  prompt: `## Layout overlays
- For a design review draw on the page instead of describing it in the abstract: browser_overlay_grid lays a column grid (and a baseline grid) over the page, browser_overlay_measure draws two elements' boxes with their sizes and the gaps between them and returns the numbers with alignment hints, browser_overlay_note puts numbered markers with labels where you see a problem. Everything is drawn in one layer that never catches clicks; it is gone with browser_overlay_clear or a reload, nothing is saved.
- After drawing, call browser_screenshot: the screenshot shows the marked-up page, and that is what the user wants to see. Clear the overlays when the review is done.
- browser_overlay_image lays a design image (an https: or data: URL) over the page at an opacity for pixel comparison — scrolling with the page, or fixed — and browser_overlay_viewport resizes the tab's window so the page's viewport matches a device width (mobile 375, tablet 768, laptop 1280, desktop 1440, or any width); preset=reset puts the window back. Use them for "does it match the design" and "how does it look on a phone" questions, then browser_screenshot.
- browser_overlay_outline draws labelled boxes around every heading (h1…h6), link and button (numbered), image (with its size), form (field count) or landmark (header/nav/main/aside/footer) — or all of them, a colour per kind — and returns the counts with the first ten of each; browser_overlay_responsive captures the page at several viewport widths in one call (default 375, 768, 1280; fullPage=true scrolls and stitches up to eight screens per width; save=true writes the PNGs to Downloads), puts the window back and reports horizontal overflow per width. Use the outlines for hierarchy and tap-target questions, the responsive captures before saying how a page behaves on other devices.
- Measure with the tools instead of estimating from a screenshot; quote the numbers (sizes, gaps, offsets) in your answer and name the grid you used (columns, gutter, max width). Headings and paragraphs have no ref — pass a selector.`,
  tools: [
    {
      name: "browser_overlay_grid",
      feature: "overlay",
      readOnly: false,
      description:
        "Draw a layout grid over the page: columns of equal width with gutters, centred, up to maxWidth (0 = the full " +
        "viewport), plus an optional baseline grid every N px. Returns the geometry (column width, x positions) for the " +
        "current viewport. Calling it again replaces the grid; on=false removes it. Then browser_screenshot.",
      shape: {
        columns: z.number().int().min(1).max(24).optional().describe("Number of columns (default 12)"),
        gutter: z.number().min(0).max(200).optional().describe("Gutter between columns in px (default 24)"),
        maxWidth: z.number().min(0).max(4000).optional().describe("Max width of the grid in px, centred (default 1200; 0 = full width)"),
        baseline: z.number().min(0).max(100).optional().describe("Baseline grid step in px (default 0 = none)"),
        color: z.string().optional().describe("Hex colour of the grid lines, e.g. #ff2d78"),
        on: z.boolean().optional().describe("false removes the grid (default true)"),
      },
    },
    {
      name: "browser_overlay_measure",
      feature: "overlay",
      readOnly: false,
      description:
        "Measure an element (A) and optionally a second one (B): draws their boxes with size labels and, with B, the " +
        "horizontal and vertical gaps between them, and returns the numbers — sizes, positions, gaps or overlaps, " +
        "offsets and alignment hints (same left/right/top/bottom/centre within 1 px). Then browser_screenshot.",
      shape: {
        ref: ref.optional().describe("Element A"),
        selector: selector.optional(),
        refB: ref.optional().describe("Element B (optional)"),
        selectorB: z.string().optional().describe("Or a CSS selector of element B"),
      },
    },
    {
      name: "browser_overlay_note",
      feature: "overlay",
      readOnly: false,
      description:
        "Put a numbered review marker with a short label on the page, at an element (ref or selector) or at viewport " +
        "coordinates x,y. list=true returns the notes placed so far; remove=N takes marker N away. Then browser_screenshot.",
      shape: {
        ref: ref.optional().describe("Element the note points at"),
        selector: selector.optional(),
        x: z.number().optional().describe("Or the x position in CSS px from the left of the visible viewport"),
        y: z.number().optional().describe("And the y position from its top"),
        text: z.string().optional().describe("The label (one short line)"),
        list: z.boolean().optional().describe("Return the notes placed so far instead of adding one"),
        remove: z.number().int().min(1).optional().describe("Remove note number N instead of adding one"),
      },
    },
    {
      name: "browser_overlay_clear",
      feature: "overlay",
      readOnly: false,
      description: "Remove the overlays from the page — everything, or only the grid, the measurements, the notes, the image or the outlines.",
      shape: { only: z.enum(["grid", "measure", "notes", "image", "outline"]).optional().describe("Remove only this kind (default: all)") },
    },
    {
      name: "browser_overlay_image",
      feature: "overlay",
      readOnly: false,
      description:
        "Lay an image over the page for pixel comparison with a design: a translucent, click-through layer in the " +
        "overlay container (browser_overlay_clear removes it) that scrolls with the page, or stays fixed to the " +
        "viewport with fixed=true. The image comes from an https: or data:image URL (attached files are not reachable " +
        "here — pass a URL). Returns the placed size and offsets; a second call replaces the image. Then browser_screenshot.",
      shape: {
        url: z.string().describe("The image: an https: URL or a data:image/… URL"),
        opacity: z.number().min(0.05).max(1).optional().describe("Opacity 0.05–1 (default 0.5)"),
        x: z.number().optional().describe("Horizontal offset in px (default 0)"),
        y: z.number().optional().describe("Vertical offset in px from the top of the document, or of the viewport with fixed=true (default 0)"),
        width: z.number().min(1).max(10000).optional().describe("Width in px (default: the image's natural width); the height follows the aspect ratio"),
        align: z.enum(["top-left", "top-center"]).optional().describe("Anchor: the page's top-left corner (default) or centred horizontally; x and y are added"),
        lock: z.boolean().optional().describe("true (default) = the image ignores the pointer; false = it catches it (to inspect it)"),
        fixed: z.boolean().optional().describe("true = fixed to the viewport instead of scrolling with the page (default false)"),
      },
    },
    {
      name: "browser_overlay_viewport",
      feature: "overlay",
      readOnly: false,
      description:
        "Resize the current tab's window so the page's viewport (window.innerWidth × innerHeight) matches a device: a " +
        "preset — mobile 375×812, mobile-landscape 812×375, tablet 768×1024, laptop 1280×800, desktop 1440×900 — or a " +
        "width (and height) in px. The window's original bounds are remembered; preset=reset restores them. Returns the " +
        "viewport size and devicePixelRatio read back from the page. Then browser_screenshot.",
      shape: {
        preset: z.enum(["mobile", "mobile-landscape", "tablet", "laptop", "desktop", "reset"]).optional().describe("A device preset, or reset to restore the window"),
        width: z.number().int().min(320).max(3840).optional().describe("Or the viewport width in px (320–3840)"),
        height: z.number().int().min(320).max(3840).optional().describe("And the viewport height in px (default: unchanged)"),
      },
    },
    {
      name: "browser_overlay_outline",
      feature: "overlay",
      readOnly: false,
      description:
        "Draw labelled outline boxes around every element of a kind, in the click-through overlay layer: headings " +
        "labelled h1/h2…, links and buttons with their number, images with their size, forms with their field count, " +
        "landmarks (header/nav/main/aside/footer) with their role; what=all outlines every kind in its own colour. " +
        "Returns the count per kind and the first ten of each with their text. Calling it again replaces the outlines; " +
        "off=true or browser_overlay_clear only=outline removes them. Then browser_screenshot.",
      shape: {
        what: z.enum(["headings", "links", "buttons", "images", "forms", "landmarks", "all"]).describe("Which elements to outline"),
        color: z.string().optional().describe("Hex colour for the boxes, e.g. #ff2d78 (default: one colour per kind)"),
        off: z.boolean().optional().describe("Remove the outlines instead of drawing (default false)"),
      },
    },
    {
      name: "browser_overlay_responsive",
      feature: "overlay",
      readOnly: false,
      description:
        "Screenshots of the page at several viewport widths in one call: for each width the tab's window is resized " +
        "(as browser_overlay_viewport does), the page captured — fullPage=true scrolls through it and stitches up to " +
        "eight screens — and the window's original bounds are restored at the end, also on an error. Returns one " +
        "image per width with a line '375 px: 375×812, page 375×2140' and notes horizontal overflow (a page wider " +
        "than its viewport). save=true also writes each PNG to Downloads.",
      shape: {
        widths: z.array(z.number().int().min(320).max(3840)).optional().describe("Viewport widths in px, 320–3840, up to 6 (default [375, 768, 1280])"),
        fullPage: z.boolean().optional().describe("Capture the whole page, scrolled and stitched (default false: the first screen)"),
        save: z.boolean().optional().describe("Also save each PNG to Downloads (default false)"),
      },
    },
  ],
};
