---
title: Design review
summary: Review a page the way a senior product designer does: hierarchy, rhythm, consistency, states, and a concrete fix for every finding.
when: the user asks what is wrong with a page, how to improve it, for feedback or a critique, for a redesign plan, or says "make it look better".
command: Review this page like a designer
prompt: Read the "design-review" playbook with browser_skill_read, then review the page I am on by it: take a screenshot, read the page, and give me the top problems in order of impact with a concrete fix for each (CSS where it applies). Offer to apply the fixes.
icon: 🔍
---
# Design review

A review is only useful if every finding comes with a reason and a fix. Look before you judge, judge by layers, and lead with the three changes that would matter most.

## Process

1. **Look first.** `browser_screenshot` at the real size, then `browser_read_page`. Note what the page is for (its one job) and who it is for. Everything below is judged against that job.
2. **Walk the layers** in the order below. Each layer has questions and a target; write down only what fails.
3. **Measure before you claim.** Use `browser_style_inspect` on the elements you call out (sizes, spacing, colours); use the overlay grid and measure tools if this build has them. "Feels cramped" becomes "16px between unrelated cards, 16px inside them — inner and outer spacing are equal".
4. **Rank by impact**, not by the order you found things: what blocks the page's job comes first, polish last.
5. **Fix, then show.** When the user wants changes applied, apply the smallest CSS that fixes the finding, screenshot again, and show before and after.

## Layers

### 1. Hierarchy and scanning
- One primary action per view. If two things shout, nothing does.
- The eye should land on: headline → supporting line → primary action → the rest. Check this on the screenshot with your eyes half closed.
- Size ratios carry hierarchy: headline at least 2× body size on marketing pages, 1.5× in dense apps. Weight and colour do the rest; never all three at once on everything.
- Secondary actions are visibly secondary (outline or text buttons), not a second filled button.

### 2. Spacing and rhythm
- Everything on one spacing scale (4/8/12/16/24/32/48/64/96). Odd values (13, 18, 27) are a smell.
- Proximity: space inside a group is smaller than space between groups. Related things sit closer together than unrelated ones.
- The primary element gets the most white space around it.
- Section padding is consistent down the page (for example 64px between every section, not 40 / 72 / 56).

### 3. Alignment
- Left edges of text and controls line up on a small number of vertical lines; a 12-column grid with equal gutters is the usual skeleton.
- Text aligns to text, icons align to the text's x-height, numbers right-align in tables.
- One alignment per block: left-aligned body text, centre only for short headlines and single-line labels.

### 4. Typography
- Body 16–18px, line-height 1.5–1.65, measure 45–75 characters.
- At most 5–6 sizes and 2–3 weights on a page; a visible scale (1.2–1.333 ratio).
- Headings tighter (line-height 1.1–1.25, slightly negative letter-spacing when large); uppercase labels get +0.05–0.1em tracking.
- Links in running text look like links (underline or a clearly different colour with 3:1 contrast against the text).

### 5. Colour and contrast
- One accent, used for actions and little else. Decoration in the accent colour steals attention from the button.
- Text contrast 4.5:1 (3:1 for large text and UI outlines). Check with the contrast tool when the build has one; muted grey text on white fails more often than designers think.
- Semantic colours (success, warning, danger) are distinct from the accent and used only for meaning.

### 6. Consistency
- Buttons of the same kind look identical everywhere (height, radius, weight, padding).
- One family of corner radii (for example 4/8/12), one icon size per context, one border style.
- Cards either all have shadows or none; the same component should not appear in two styles.

### 7. States and feedback
- Hover, focus-visible, active, disabled, loading, empty, error: each interactive element has them, and focus is visible for keyboard users (2px outline, 2px offset).
- Errors say what happened and what to do, next to the thing that failed.
- Nothing jumps when it loads (reserve space for images and lazy content).

### 8. Content
- The words do work: headline states the outcome, buttons start with a verb, no "Click here". (See the ux-writing playbook when the copy is the problem.)

### 9. Responsiveness
- At a narrow viewport the primary action is still visible without scrolling sideways; tap targets are at least 44×44px; nothing overflows.

## Severity

| Level | Meaning | Examples |
| --- | --- | --- |
| Blocking | Stops the page doing its job or excludes users | Primary action not findable; body text below 3:1 contrast; focus invisible |
| Major | Hurts comprehension or trust | Two competing primary buttons; inconsistent spacing throughout; headings with no hierarchy |
| Minor | Polish | Mixed corner radii; a 13px gap; one off-scale font size |

## Report format

Lead with a two-line summary (what the page is for, how well it does it). Then a table, most severe first, at most ten rows:

| # | Problem (where) | Why it matters | Fix | Effort |
| --- | --- | --- | --- | --- |

"Fix" is concrete: a value, a CSS rule, a layout move, a copy rewrite. "Effort" is S / M / L. End with the three changes you would do first, and offer to apply the CSS-level ones.

## Rules

- Critique the work, never the people who made it; keep the brand's identity (typeface, colour, voice) unless asked to change it.
- Do not propose a full redesign when three targeted changes would do. Precision earns trust.
- Every CSS fix you apply must be reversible and scoped; tell the user how to remove it.

## Checklist

- [ ] Looked (screenshot + read) and named the page's job before judging
- [ ] Every finding measured, with a reason and a concrete fix
- [ ] Ranked by impact; the three changes that matter most come first
- [ ] Brand identity kept; fixes scoped and reversible
- [ ] Before/after shown when something was applied
