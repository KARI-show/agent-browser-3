import { z } from "zod";
import type { ExtraFeature } from "./types";

// Link and URL checks: one-shot HTTP status checks run from the side panel (which has host permissions
// for every URL, so fetch works without CORS), plus three audits of the current tab and its site: on-page
// SEO, speed from the Performance API, and the sitemap. browser/extras/checks.js implements the tools,
// the 🔗 Checks tab and the quick commands. Every tool only observes, so they are all read-only.
export const checks: ExtraFeature = {
  id: "checks",
  prompt: `## Checks
- browser_check_links requests every link of the current page (HEAD, GET when HEAD is refused; 6 at a time, 10 s each) and reports the broken ones (4xx/5xx or unreachable) with their link text and target, the redirects, the counts and the slowest few. Use it when the user asks about broken/dead links or the health of a page; selector="footer, nav" limits it to a part of the page, sameOriginOnly=true to the site's own links.
- browser_check_url checks one address or a list (up to 20) the same way: status, final URL after redirects, response time, content type and size, or "down: <reason>" when the request fails. Use it for "is this URL up / what does it return" — the page itself is not opened.
- browser_check_seo audits the current page's on-page SEO as ✓/⚠ lines (title and description lengths, canonical, robots, viewport, lang, h1, image alt, links, Open Graph/Twitter, structured data, word count); browser_check_speed reads the tab's Performance API (TTFB, DOM and load events, paints and LCP, requests and transfer by type, the slowest resources) and flags the slow values; browser_check_sitemap reads a site's robots.txt and sitemap(s), index files included, counts the URLs and checks the first few. Use them for "is this page SEO-friendly / why is it slow / is the sitemap fine" — run the audit before giving advice, and quote its numbers.`,
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
    {
      name: "browser_check_seo",
      feature: "checks",
      readOnly: true,
      description:
        "On-page SEO audit of the current tab, read in one pass: title and meta description with their lengths, " +
        "canonical (and whether it points elsewhere), meta robots, viewport, html lang and hreflang, h1 count and " +
        "texts plus h2/h3 counts, images without alt (with samples), links internal/external/nofollow, Open Graph " +
        "and Twitter card, ld+json blocks and their @type, word count. Returns ✓/⚠ lines and a verdict " +
        "(\"12 checks: 9 ok, 3 warnings\"). Nothing is changed on the page.",
      shape: {},
    },
    {
      name: "browser_check_speed",
      feature: "checks",
      readOnly: true,
      description:
        "Page speed of the current tab from its Performance API: navigation type, TTFB, DOM interactive, " +
        "DOMContentLoaded, load, first paint, first contentful paint and LCP (when available), the requests and " +
        "transfer size by type (script, css, img, font, xhr/fetch, other), the 5 slowest resources and the total. " +
        "Values in ms and kB; flags TTFB > 800 ms, load > 3 s, more than 3 MB or more than 100 requests. " +
        "Reload the page first when the user wants a fresh measurement.",
      shape: {},
    },
    {
      name: "browser_check_sitemap",
      feature: "checks",
      readOnly: true,
      description:
        "Check a site's sitemap: fetches robots.txt of the origin (its Sitemap: lines and Disallow count), then " +
        "/sitemap.xml and every sitemap robots.txt names (sitemap index files are followed, up to 5 nested " +
        "sitemaps), counts the listed URLs, shows the first 10 and checks the HTTP status of the first `max` " +
        "(HEAD with GET fallback, 6 at a time). Returns the counts (sitemaps found, URLs listed, ok/redirected/" +
        "broken) and the broken ones. A missing robots.txt or sitemap is reported, not an error.",
      shape: {
        url: z.string().optional().describe("The site (default: the current tab's origin); an address ending in .xml is read as the sitemap itself"),
        max: z.number().int().min(1).max(50).optional().describe("How many of the listed URLs to check (default 10, up to 50)"),
      },
    },
  ],
};
