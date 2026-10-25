---
title: UX writing
summary: Microcopy that works — buttons as verbs, errors that say what happened and what to do, empty states that lead somewhere, one tone, short lines — with before/after patterns.
when: writing or fixing labels, buttons, error messages, empty states, onboarding, notifications or form hints, or when the words on a page confuse people.
command: Improve the copy on this page
prompt: Read the "ux-writing" playbook with browser_skill_read, read the copy of the page I am on (headings, buttons, labels, hints, errors, empty states), list what breaks the playbook's rules with a rewrite for each, and apply the text changes with browser_element_edit if available; otherwise show them as a before/after table.
icon: ✍️
---
# UX writing

Interface text has one job: let the person do the next thing without thinking about the words. Clear beats clever; specific beats polite; short beats complete.

## Principles

1. **Front-load the verb and the object.** "Save changes", "Send invoice", "Delete 3 files". The first word tells the person what will happen.
2. **One idea per sentence**, about 12 words, in the active voice. Split anything with "and" in the middle.
3. **Say what happens next**, not what the system did. "Your receipt is on its way" beats "Email sent successfully".
4. **Use the person's words**, not the system's. "Password" not "credential"; "Sign in" not "authenticate"; no error codes before the explanation.
5. **One tone everywhere**: second person ("you"), sentence case for UI text, no exclamation marks except for genuinely good news, no jokes in errors.

## Buttons and links

- Verb + object, 1–3 words: Save changes · Create project · Send · Try again.
- Never "OK", "Submit", "Yes/No", "Click here". The button answers the question the dialog asks: "Discard draft?" → "Discard" / "Keep editing".
- Destructive actions name the loss: "Delete 3 files" and the confirmation repeats it.
- Links say where they go: "View pricing", "Download the report (PDF, 2 MB)".
- Primary and secondary buttons are visibly different and the primary is the safe, expected path.

## Errors

Structure: **what happened → why (if useful) → what to do**, next to the thing that failed, in plain words.

| Before | After |
| --- | --- |
| Error 402 | Card declined. Try another card or contact your bank. |
| Invalid input | Enter a phone number with a country code, like +44 20 7946 0000. |
| Something went wrong | We couldn't save your changes. Check your connection and try again — nothing was lost. |
| Password doesn't meet requirements | Use at least 12 characters, with a number or a symbol. |

Never blame ("you entered the wrong…"); never "please" twice; never a dead end — every error has a way out (retry, fix, contact).

## Empty states

Three parts: what this place is, why it is empty, the one action that fills it. "No invoices yet. Invoices you send will show up here. **Create your first invoice**." Add an example or illustration only if it helps understanding.

## Forms

- Labels above fields, visible always; placeholders show a format example, never the label.
- Help text under the field, one line, before the person types; errors replace the help text on failure.
- Mark required fields in words when most are optional ("Optional" on the few that are) rather than asterisks everywhere.
- Ask in the person's order: name before address, address before payment.

## Confirmations and notifications

- Confirm with the result: "Saved", "Invite sent to ana@…", and offer undo where possible instead of asking "Are you sure?" first.
- Ask for confirmation only for destructive or irreversible actions, and name what will be lost.
- Notifications: lead with the fact, then the action; one sentence; disappear on their own unless they need a decision.

## Loading and progress

Say what is happening and, if it takes more than a few seconds, how long: "Importing 240 contacts… about a minute." Skeletons beat spinners; spinners beat nothing.

## Headlines and body on marketing pages

- Headline ≤ 8 words, says the outcome; subhead ≤ 20 words, says how and for whom.
- Benefits before features; numbers specific ("saves 4 hours a week", not "saves time"); drop "innovative, seamless, powerful, robust, cutting-edge".
- Read it aloud; if you would not say it to a customer, rewrite it.

## Length limits

| Element | Limit |
| --- | --- |
| Button | 1–3 words |
| Headline | ≤ 8 words |
| Subhead / description | ≤ 20 words |
| Toast | 1 sentence |
| Error | ≤ 2 sentences, action last |
| Tooltip | ≤ 12 words; if longer it needs a help page |

## Localisation and accessibility

- Avoid idioms and culture-bound jokes; leave room (German runs 30% longer).
- Dates and numbers in the person's format; currency with its code when ambiguous.
- Link and button text makes sense out of context (screen readers list them alone).

## Checklist

- [ ] Buttons: verb + object, no "OK/Submit/Click here"
- [ ] Errors: what happened, what to do, no blame, no dead ends
- [ ] Empty states: what, why, one action
- [ ] Labels visible; placeholders are examples
- [ ] Sentence case, second person, one tone
- [ ] Headline ≤ 8 words, specific numbers, no filler adjectives
