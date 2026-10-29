import { z } from "zod";
import type { ExtraFeature } from "./types";

/**
 * Forms: a page's form read as the user sees it (every field with its label, value, required flag
 * and validation state, grouped by <form>), and drafts of what was typed — saved per page, brought
 * back by field key. browser/extras/forms.js implements the tools in the side panel over the
 * autofill extra's field collector and filler, adds the 📝 Drafts tab and the "Forms" quick commands.
 * Drafts never hold passwords, card numbers or other secrets.
 */
export const forms: ExtraFeature = {
  id: "forms",
  prompt: `## Forms
- Before the user submits a form, browser_form_read shows it as they see it: every field with its label, value, required flag and the browser's own validation state, grouped by form with its submit buttons. Use it to answer "what is still missing?" or "why won't it submit?" — name the empty required and invalid fields; only the user submits.
- For a long form, browser_form_draft_save keeps what was typed as a draft of this page (one per page, by its address without the query) and browser_form_draft_restore puts it back by field — after a reload, a session timeout or on a second visit; list=true shows the drafts, delete=true removes one. Say what was restored and what was skipped or missing.
- Drafts and form reports never hold passwords, card numbers, CVVs, IBANs or other secrets — a password shows only as its length — and nothing is ever submitted by these tools.`,
  tools: [
    {
      name: "browser_form_read",
      feature: "forms",
      readOnly: true,
      description:
        "Read the current page's form as the user sees it (all frames): every visible field with its label, " +
        "type, current value (a password only as its length), required flag, disabled/read-only state, the " +
        "browser's validation state (valid, validation message), the options of a select and the checked " +
        "state of a checkbox or radio — grouped by <form> (name, id, action host) with the labels of its " +
        "submit buttons. The first line sums it up: fields, required fields still empty, invalid fields. " +
        "Nothing is changed or submitted.",
      shape: {},
    },
    {
      name: "browser_form_draft_save",
      feature: "forms",
      readOnly: false,
      description:
        "Save the values the user has typed into the current page's form as a draft of this page (its " +
        "address without the query), one field per stable key (id, else name, else label), replacing an " +
        "earlier draft of the same page; up to 50 drafts, values up to 2000 characters. Empty fields, " +
        "password fields and anything that looks like a card number, CVV, IBAN, SSN or other secret are " +
        "skipped and reported. Returns how many fields were kept and which were skipped.",
      shape: {},
    },
    {
      name: "browser_form_draft_restore",
      feature: "forms",
      readOnly: false,
      description:
        "Fill the current page's form from its saved draft (default: the draft of the current page; url " +
        "picks another page's draft), field by field through the page's own input/change events, without " +
        "touching fields that already hold a value unless overwrite=true and without submitting. Reports " +
        "what was filled, what was skipped as already filled and which draft fields are missing on the page. " +
        "list=true lists the saved drafts instead (page, title, age, field count); delete=true deletes the " +
        "draft instead of restoring it.",
      shape: {
        url: z.string().optional().describe("The page whose draft to use (default: the current page's address)"),
        overwrite: z.boolean().optional().describe("Also replace values the fields already hold (default false)"),
        delete: z.boolean().optional().describe("Delete the draft instead of restoring it (default false)"),
        list: z.boolean().optional().describe("List the saved drafts instead (default false)"),
      },
    },
  ],
};
