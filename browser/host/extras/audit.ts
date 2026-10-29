import { z } from "zod";
import type { ExtraFeature } from "./types";

/**
 * Identity report: what the current site sees of this browser (User-Agent, client hints, platform,
 * languages, time zone, screen, hardware — read in the page's own world, so a device profile's
 * overrides are included) and what the extension knows (the site's cookie count, whether the window
 * carries a device profile, whether a proxy is applied), with a one-line verdict and warnings about
 * inconsistencies. For checking a device profile or proxy before signing in. Read-only: it shows no
 * cookie values and no credentials. Two more checks: browser_identity_proxy fetches a trace endpoint
 * from the panel (so through the browser's proxy settings) and compares the exit with the proxy the
 * extension expects; browser_identity_leaks runs leak probes in the page (WebRTC, time zone, languages,
 * screen, webdriver, client hints…); browser_identity_fingerprint takes the readings a fingerprinting
 * script takes (canvas, WebGL, audio, fonts, hardware) as short hashes and compares them with the device
 * profile the tab presents. The runtime half is browser/extras/audit.js.
 */
export const audit: ExtraFeature = {
  id: "audit",
  prompt: `## Identity report
- browser_identity_report shows what the current site sees of this browser (User-Agent, client hints, platform, languages, time zone, screen, hardware, cookies enabled, webdriver flag) and what the extension knows (the site's cookie count, whether this window carries a device profile, whether a proxy is applied), with a verdict line and warnings about inconsistencies — a profile whose template differs from the User-Agent in use, a time zone that does not match the profile, client hints that disagree with the User-Agent.
- Run it before signing in to an account that must come from a particular device or place, and whenever the user asks what a site sees or whether a profile or proxy is in effect. Report mismatches plainly and suggest the fix (launch the right profile, repair the proxy) instead of signing in. To compare two tabs, switch to each and run it there.
- browser_identity_proxy shows the exit the world sees (IP, country, latency, fetched through the browser's proxy settings) against the proxy the extension expects and the profile's language and time zone; browser_identity_leaks checks the current tab for leaks a site could use (a raw IP in WebRTC candidates, a time zone or language that disagrees with the profile, navigator.webdriver, implausible screen or hardware values) and ends with a verdict. Run both when a sign-in must look like it comes from a particular place; a country that disagrees with the profile's language is advice, not an error.
- browser_identity_fingerprint reads what a fingerprinting script reads in the current tab — canvas, WebGL vendor/renderer and parameters, audio, the common fonts present, screen, hardware, time zone, languages — as short hashes and values, compares them with the device profile the tab presents (GPU strings, CPU threads, memory, screen, time zone, whether canvas and audio noise are on) and ends with one combined hash: two tabs with different hashes are different devices to a site. Run it to check that a profile actually changed what sites measure, or to compare two profiles tab by tab.`,
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
    {
      name: "browser_identity_proxy",
      feature: "audit",
      readOnly: true,
      description:
        "Check what the exit of this browser looks like: fetches Cloudflare's trace endpoint from the extension (so " +
        "through the browser's proxy settings; 10 s timeout) and reports the exit IP, country, data centre, TLS and " +
        "HTTP versions and the round-trip latency, compared with what the extension expects — the active device " +
        "profile's proxy or the global proxy setting ('direct' vs 'through type://host:port', never credentials) and " +
        "whether the exit country agrees with the profile's language and time zone (a disagreement is advice, not an " +
        "error). A network failure is reported as 'the exit could not be reached', not thrown.",
      shape: {},
    },
    {
      name: "browser_identity_leaks",
      feature: "audit",
      readOnly: true,
      description:
        "Leak and consistency checks of the current tab, run in the page itself: WebRTC (host candidates gathered for " +
        "up to 2 s — a raw private or public IP instead of an mDNS .local name is a leak risk), time zone (Intl zone vs " +
        "Date offset vs the device profile's zone), languages (navigator.language vs languages[0] vs the profile), " +
        "screen vs window plausibility, navigator.webdriver, hardwareConcurrency / deviceMemory present, plugins, Do " +
        "Not Track, User-Agent vs client hints, touch points vs a desktop User-Agent. Returns ✓ / ⚠ lines and a short " +
        "verdict naming the risks. Read-only; no cookie values.",
      shape: {},
    },
    {
      name: "browser_identity_fingerprint",
      feature: "audit",
      readOnly: true,
      description:
        "What a fingerprinting script reads in the current tab, taken in the page's own world by one self-contained probe: a canvas " +
        "hash (a fixed 300×150 scene of text, emoji, arcs and gradients, FNV-1a of its data URL), WebGL vendor and renderer " +
        "(UNMASKED_* via WEBGL_debug_renderer_info) and a hash of a fixed parameter list, an audio hash (OfflineAudioContext " +
        "oscillator, 2 s limit), which of ~30 common fonts are present, screen / pixel ratio / colour depth, CPU threads, memory, " +
        "time zone, languages, touch points, plugins — compared with the device profile the tab presents (expected GPU strings, " +
        "threads, memory, screen, time zone; whether canvas and audio noise are on), with ✓ / ⚠ lines and one combined short " +
        "hash: a different hash is a different device to the site. Read-only; no cookie values.",
      shape: {},
    },
  ],
};
