import { z } from "zod";
import type { ExtraFeature } from "./types";

// Link and URL checks: one-shot HTTP status checks run from the side panel (which has host permissions
// for every URL, so fetch works without CORS). browser/extras/checks.js implements the tools, the
// 🔗 Checks tab and the quick commands. Both tools only observe, so they are read-only.
export const checks: ExtraFeature = {
  id: "checks",
  prompt: `## Checks
- browser_check_links requests every link of the current page (HEAD, GET when HEAD is refused; 6 at a time, 10 s each) and reports the broken ones (4xx/5xx or unreachable) with their link text and target, the redirects, the counts and the slowest few. Use it when the user asks about broken/dead links or the health of a page; selector="footer, nav" limits it to a part of the page, sameOriginOnly=true to the site's own links.
- browser_check_url checks one address or a list (up to 20) the same way: status, final URL after redirects, response time, content type and size, or "down: <reason>" when the request fails. Use it for "is this URL up / what does it return" — the page itself is not opened.`,
  tools: [
    {
      name: "browser_check_url",
      feature: "checks",
      readOnly: true,
      description:
        "Check what an address returns without opening it: HTTP status, whether it is ok, the final URL when it " +
        "redirects, the response time, the content type and size. HEAD request with a GET fallback (405/501 or a " +
        "failed HEAD), redirects followed, 10 s timeout; an unreachable address is reported as \"down: <reason>\". " +
        "Pass url for one address or urls for several (up to 20).",
      shape: {
        url: z.string().optional().describe("The address to check (https:// is added if missing)"),
        urls: z.array(z.string()).max(20).optional().describe("Several addresses at once (up to 20)"),
      },
    },
    {
      name: "browser_check_links",
      feature: "checks",
      readOnly: true,
      description:
        "Find broken links on the current page: collects the http(s) links of the top frame (deduplicated, up to " +
        "150) and checks each one (HEAD with GET fallback, 6 at a time, 10 s timeout). Reports the broken links " +
        "(4xx/5xx or unreachable) with their link text and target, the redirected ones, counts of ok/redirected/" +
        "broken and the slowest few. The result is also shown in the panel's 🔗 Checks tab.",
      shape: {
        sameOriginOnly: z.boolean().optional().describe("Only links to the page's own origin (default false)"),
        includeExternal: z.boolean().optional().describe("Also check links to other sites (default true)"),
        selector: z.string().optional().describe("Only links inside elements matching this CSS selector, e.g. \"footer, nav\""),
      },
    },
  ],
};
