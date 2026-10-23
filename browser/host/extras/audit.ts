import { z } from "zod";
import type { ExtraFeature } from "./types";

/**
 * Identity report: what the current site sees of this browser (User-Agent, client hints, platform,
 * languages, time zone, screen, hardware — read in the page's own world, so a device profile's
 * overrides are included) and what the extension knows (the site's cookie count, whether the window
 * carries a device profile, whether a proxy is applied), with a one-line verdict and warnings about
 * inconsistencies. For checking a device profile or proxy before signing in. Read-only: it shows no
 * cookie values and no credentials. The runtime half is browser/extras/audit.js.
 */
export const audit: ExtraFeature = {
  id: "audit",
  prompt: `## Identity report
- browser_identity_report shows what the current site sees of this browser (User-Agent, client hints, platform, languages, time zone, screen, hardware, cookies enabled, webdriver flag) and what the extension knows (the site's cookie count, whether this window carries a device profile, whether a proxy is applied), with a verdict line and warnings about inconsistencies — a profile whose template differs from the User-Agent in use, a time zone that does not match the profile, client hints that disagree with the User-Agent.
- Run it before signing in to an account that must come from a particular device or place, and whenever the user asks what a site sees or whether a profile or proxy is in effect. Report mismatches plainly and suggest the fix (launch the right profile, repair the proxy) instead of signing in. To compare two tabs, switch to each and run it there.`,
  tools: [
    {
      name: "browser_identity_report",
      feature: "audit",
      readOnly: true,
      description:
        "Report what the current site sees of this browser and what the extension knows about this window: " +
        "User-Agent, client hints (brands, platform, mobile), platform, languages, time zone and locale, screen " +
        "and window size, CPU threads, memory, touch points, cookies enabled, navigator.webdriver, Do Not Track, " +
        "storage estimate — read in the page's own world; plus the site's cookie count (no values), whether the " +
        "tab's window carries a device profile (its label only) and whether a proxy is applied (mode and host:port, " +
        "never credentials). Starts with a one-line verdict and warnings about inconsistencies.",
      shape: {},
    },
  ],
};
