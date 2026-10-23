import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "checks"` on
// every tool; browser/extras/checks.js implements them in the side panel.
void z;
export const checks: ExtraFeature = {
  id: "checks",
  prompt: "",
  tools: [],
};
