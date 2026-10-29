import { z } from "zod";
import type { ExtraFeature } from "./types";

/**
 * Autofill identities: named sets of personal or business field values (name, email, phone,
 * address, company…) the user fills forms with — never passwords, card numbers or other secrets.
 * browser/extras/autofill.js stores them in chrome.storage.local, implements the tools, matches a
 * page's form fields to the identity's keys, adds the 🪪 Identities tab and the "Forms" quick
 * commands.
 */
export const autofill: ExtraFeature = {
  id: "autofill",
  prompt: `## Autofill
- Identities are the user's own details saved for forms (browser_autofill_save, e.g. "remember my details: …" or the values they typed into a form, as key → value such as firstName, email, phone, company, address, city, zip, country). Save one when the user asks to remember their details; browser_autofill_list shows what is saved. Never save or fill passwords, PINs, card numbers or other secrets — the save tool refuses such keys, and a secret stays with the user.
- To fill a form: browser_autofill_apply with the identity's name (or id) matches the page's fields by their labels and attributes and fills them, selects included, without touching fields that already hold a value (overwrite=true changes that) and without submitting anything. Use dryRun=true to show the plan first when the form is long or the match is unsure. Then say what was filled and what was not — the user checks the form and fills the rest (or you type it with browser_type), and only the user submits.
- browser_autofill_from_page builds an identity from what the user already typed into the page's form (the fields it recognises — name, email, phone, address…; never passwords, card numbers or other secrets) and saves it under a name, merging into an existing identity of that name unless merge=false. Use it for "remember what I entered here"; tell the user which values were kept and which fields were not.`,
  tools: [
    {
      name: "browser_autofill_save",
      feature: "autofill",
      readOnly: false,
      description:
        "Save (or update) an identity: a named set of the user's details for filling forms, as key → value " +
        "(firstName, lastName, email, phone, company, jobTitle, address, address2, city, state, zip, country, " +
        "website, linkedin, github, twitter, birthday — free keys are normalised to camelCase). Saving under an " +
        "existing name merges the fields (new keys override, others stay). Keys that name a password, PIN, " +
        "card, IBAN, SSN or token are refused: identities never hold secrets. Up to 20 identities.",
      shape: {
        name: z.string().describe("Identity name, e.g. 'Personal', 'Work' or 'Shipping to Mum'"),
        fields: z.record(z.string(), z.string()).describe("key → value, e.g. { firstName: 'Ann', email: 'ann@example.com' } (values up to 500 characters)"),
      },
    },
    {
      name: "browser_autofill_apply",
      feature: "autofill",
      readOnly: false,
      description:
        "Fill the current page's form with a saved identity: matches the visible text inputs, textareas and " +
        "selects (all frames) to the identity's keys by label, name, id, placeholder and autocomplete attribute, " +
        "sets the values the way the page expects (input/change events), never fills password fields, skips " +
        "fields that already hold a value unless overwrite=true, and submits nothing. Returns what was filled " +
        "(field ← key = value), which keys found no field and which fields stayed empty; dryRun returns that " +
        "plan without filling.",
      shape: {
        name: z.string().optional().describe("Identity name (case-insensitive); with one identity saved, name and id may be left out"),
        id: z.string().optional().describe("Or its id from browser_autofill_list"),
        only: z.array(z.string()).optional().describe("Fill only these keys, e.g. ['email', 'phone']"),
        overwrite: z.boolean().optional().describe("Also replace values the fields already hold (default false)"),
        dryRun: z.boolean().optional().describe("Only report what would be filled (default false)"),
      },
    },
    {
      name: "browser_autofill_list",
      feature: "autofill",
      readOnly: true,
      description: "List the saved identities: id, name, their keys with values, use count and last update.",
      shape: {},
    },
    {
      name: "browser_autofill_delete",
      feature: "autofill",
      readOnly: false,
      description: "Delete a saved identity by name or id.",
      shape: {
        name: z.string().optional().describe("Identity name"),
        id: z.string().optional().describe("Or its id"),
      },
    },
    {
      name: "browser_autofill_from_page",
      feature: "autofill",
      readOnly: false,
      description:
        "Save an identity from the values the user already typed into the current page's form (all frames): " +
        "each filled field is mapped to an identity key by its label, name, placeholder and autocomplete " +
        "attribute (first name, email, phone, company, address, city, zip, country…); fields that match no " +
        "key are listed as not kept, and password fields or anything that looks like a card number, CVV, " +
        "IBAN, SSN or other secret is never kept. Merges into an existing identity of that name (merge=true, " +
        "the default) or replaces its fields (merge=false). Returns the keys kept with their values and what " +
        "was skipped.",
      shape: {
        name: z.string().describe("Identity name to save under, e.g. 'Personal' or 'Work'"),
        merge: z.boolean().optional().describe("Merge into an existing identity of that name (default true); false replaces its fields"),
      },
    },
  ],
};
