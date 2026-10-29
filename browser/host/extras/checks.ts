import { z } from "zod";
import type { ExtraFeature } from "./types";

// Link and URL checks: one-shot HTTP status checks run from the side panel (which has host permissions
// for every URL, so fetch works without CORS), plus audits of the current tab and its site: on-page SEO,
// speed from the Performance API, the sitemap, accessibility and mobile readiness (one injected read each),
// the redirect chain and the response headers of an address. browser/extras/checks.js implements the
// tools, the 🔗 Checks tab and the quick commands. Every tool only observes, so they are all read-only.
export const checks: ExtraFeature = {
  id: "checks",
  prompt: `## Checks
- browser_check_links requests every link of the current page (HEAD, GET when HEAD is refused; 6 at a time, 10 s each) and reports the broken ones (4xx/5xx or unreachable) with their link text and target, the redirects, the counts and the slowest few. Use it when the user asks about broken/dead links or the health of a page; selector="footer, nav" limits it to a part of the page, sameOriginOnly=true to the site's own links.
- browser_check_url checks one address or a list (up to 20) the same way: status, final URL after redirects, response time, content type and size, or "down: <reason>" when the request fails. Use it for "is this URL up / what does it return" — the page itself is not opened.
- browser_check_seo audits the current page's on-page SEO as ✓/⚠ lines (title and description lengths, canonical, robots, viewport, lang, h1, image alt, links, Open Graph/Twitter, structured data, word count); browser_check_speed reads the tab's Performance API (TTFB, DOM and load events, paints and LCP, requests and transfer by type, the slowest resources) and flags the slow values; browser_check_sitemap reads a site's robots.txt and sitemap(s), index files included, counts the URLs and checks the first few. Use them for "is this page SEO-friendly / why is it slow / is the sitemap fine" — run the audit before giving advice, and quote its numbers.
- browser_check_accessibility audits the current page for accessibility (images without alt, unlabeled form controls, icon-only buttons/links, generic link texts, heading skips, landmarks, html lang, positive tabindex, duplicate ids, untitled iframes, target=_blank without rel=noopener, aria-hidden with focusable content, autoplaying media — not colour contrast) and browser_check_mobile for mobile readiness (viewport meta, tap targets under 44 px, text under 12 px, elements wider than the viewport, overlays, fixed widths over 375 px, plugins); both return ✓/⚠ lines with counts, samples and a verdict. browser_check_redirects follows an address's redirect chain hop by hop (status, target, latency, http→https, loops, final URL) and browser_check_headers reports an address's response headers that matter (server, content type, compression, caching, the security headers with a "security headers n/7" verdict, cookie flags without values). Use them for "is this page accessible / mobile-friendly", "where does this URL redirect to" and "are the security headers set".`,
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
    {
      name: "browser_check_accessibility",
      feature: "checks",
      readOnly: true,
      description:
        "Accessibility audit of the current tab, read in one pass: images without alt, form controls without an " +
        "accessible name (no label, aria-label, aria-labelledby, title or placeholder), buttons and links without " +
        "text (icon-only, no aria-label), generic link texts (\"click here\", \"read more\", …), heading level " +
        "skips (h1 → h3), missing landmarks (main, nav, banner, contentinfo), html lang, positive tabindex, " +
        "duplicate ids, iframes without title, target=_blank links without rel=noopener (advice), aria-hidden " +
        "elements with focusable content, autoplaying media. Returns ✓/⚠ lines with counts and up to 5 " +
        "selectors each, and a verdict. Text contrast is not checked here (that is the palette tool's job).",
      shape: {},
    },
    {
      name: "browser_check_mobile",
      feature: "checks",
      readOnly: true,
      description:
        "Mobile readiness of the current tab, read in one pass at its current width: the viewport meta (present, " +
        "width=device-width, zoom not blocked by user-scalable=no or a low maximum-scale), tap targets smaller " +
        "than 44×44 CSS px among links, buttons and inputs, visible text under 12 px, elements wider than the " +
        "viewport (the widest offenders), fixed or sticky elements covering over 25% of the viewport, horizontal " +
        "overflow, elements with a fixed width or min-width over 375 px (what would overflow a phone — the tab is " +
        "not resized), legacy plugins (object/embed). Returns ✓/⚠ lines with counts and samples, and a verdict.",
      shape: {},
    },
    {
      name: "browser_check_redirects",
      feature: "checks",
      readOnly: true,
      description:
        "Follow an address's redirect chain hop by hop without opening it (GET with redirects not followed, " +
        "10 s per hop, cookies sent): each hop's status, Location, latency and whether it upgrades http → https " +
        "or downgrades to http, loop detection, the final URL and status. When the browser hides the " +
        "intermediate hops, the chain is observed through webRequest or reported as one hidden redirect to the " +
        "final address. Default: the current tab's URL.",
      shape: {
        url: z.string().optional().describe("The address to follow (default: the current tab's URL; https:// is added if missing)"),
        max: z.number().int().min(1).max(20).optional().describe("Maximum hops to follow (default 10, up to 20)"),
      },
    },
    {
      name: "browser_check_headers",
      feature: "checks",
      readOnly: true,
      description:
        "The response headers of an address that matter, from one GET (redirects followed, 10 s timeout): server, " +
        "content-type and charset, compression (content-encoding), caching (cache-control, expires, etag, " +
        "last-modified) with advice, strict-transport-security, content-security-policy (present and its length), " +
        "x-frame-options / frame-ancestors, x-content-type-options, referrer-policy, permissions-policy, cookie " +
        "flags (Secure / HttpOnly / SameSite counts, values never shown) and the HTTP version when exposed. Each " +
        "as a ✓/⚠ line, with a verdict like \"security headers 4/7\". Default: the current tab's URL.",
      shape: {
        url: z.string().optional().describe("The address to request (default: the current tab's URL; https:// is added if missing)"),
      },
    },
  ],
};
