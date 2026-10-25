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
      description: "Remove the overlays from the page — everything, or only the grid, the measurements or the notes.",
      shape: { only: z.enum(["grid", "measure", "notes"]).optional().describe("Remove only this kind (default: all)") },
    },
  ],
};
