import { z } from "zod";
import type { ExtraFeature } from "./types";

/**
 * Selection editing: the agent reads what the user selected on the page and puts a rewritten
 * version back into the same field. browser/extras/rewrite.js implements the tools in the side
 * panel and adds the ✍️ Rewrite tab and the "Writing" quick commands.
 */
export const rewrite: ExtraFeature = {
  id: "rewrite",
  prompt: `## Rewriting text
- To rewrite what the user selected: browser_selection_get (read the selection and where it sits) → write the new version yourself → browser_selection_replace with the result. Always read the selection first; never guess what is selected.
- Keep the author's language, meaning and formatting (line breaks, lists, markdown, names, numbers, links) unless the request is about them. Change only what was asked — tone, length, grammar, translation — and never add facts, names or claims that are not in the original.
- browser_selection_replace works only inside an editable control (input, textarea, rich-text editor). When the selection is plain page content (an article, a received message), show the rewritten text in the chat instead.
- If nothing is selected but a text field has focus, browser_selection_get returns its whole value (wholeField: true). Rewrite the whole field only when the user asked for the whole text; pass wholeField=true to browser_selection_replace then.
- Before replacing anything longer than a paragraph (or a whole field), show the new text and ask the user to confirm with AskUserQuestion. A sentence or a heading can be replaced right away; mention what changed in one line.`,
  tools: [
    {
      name: "browser_selection_get",
      feature: "rewrite",
      readOnly: true,
      description:
        "Read the text the user selected in the current tab (top frame): the selected text, its length, and " +
        "whether it sits in an editable control (input, textarea or rich-text editor — with the field's kind " +
        "and label) or in plain page content. When nothing is selected but a text field has focus, returns " +
        "the field's whole value with wholeField: true. Call it before rewriting; the selection is the " +
        "user's, so never guess it.",
      shape: {},
    },
    {
      name: "browser_selection_replace",
      feature: "rewrite",
      readOnly: false,
      description:
        "Replace the current selection inside the focused editable control (input, textarea or rich-text " +
        "editor) with new text, firing the page's input/change events, and verify the field shows it. Fails " +
        "when the selection is plain page content — show the rewritten text in the chat then. When nothing " +
        "is selected but a field has focus, replaces its whole value only with wholeField=true.",
      shape: {
        text: z.string().describe("The new text that replaces the selection"),
        wholeField: z.boolean().optional().describe("Nothing selected: replace the whole value of the focused field (default false — refuses instead)"),
      },
    },
  ],
};
