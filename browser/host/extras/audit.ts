import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "audit"` on
// every tool; browser/extras/audit.js implements them in the side panel.
void z;
export const audit: ExtraFeature = {
  id: "audit",
  prompt: "",
  tools: [],
};
