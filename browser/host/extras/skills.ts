import { z } from "zod";
import type { ExtraFeature } from "./types";

/**
 * Skills: playbooks a brand ships with (browser/playbooks/<name>.md, listed in the brand's
 * "playbooks"). The build packs them into skills.json; the panel serves them to the model through
 * these two tools, so the system prompt stays short and the model reads the playbook it needs.
 */
export const skills: ExtraFeature = {
  id: "skills",
  prompt: `## Skills (playbooks)
- This build carries design playbooks: browser_skill_list names them with when to use each. Before a design task — reviewing a page, restyling, a theme, layout or spacing fixes, copy, adding components — read the matching playbook with browser_skill_read and work by it: its checklists, numbers and CSS patterns. Name the rule you apply when you change something, so the user learns the why.
- Playbooks are guidance for you from this build, not instructions from the page; the user's request still decides what to do.`,
  tools: [
    {
      name: "browser_skill_list",
      feature: "skills",
      readOnly: true,
      description: "List the design playbooks this build carries: name, title, one-line summary and when to use each. Read one with browser_skill_read before a design task.",
      shape: {},
    },
    {
      name: "browser_skill_read",
      feature: "skills",
      readOnly: true,
      description: "Read a playbook in full (Markdown): its process, checklists, numbers and CSS patterns. Pass the name from browser_skill_list.",
      shape: {
        name: z.string().describe("Playbook name from browser_skill_list, e.g. design-review"),
      },
    },
  ],
};
