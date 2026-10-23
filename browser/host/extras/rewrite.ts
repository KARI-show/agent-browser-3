import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "rewrite"` on
// every tool; browser/extras/rewrite.js implements them in the side panel.
void z;
export const rewrite: ExtraFeature = {
  id: "rewrite",
  prompt: "",
  tools: [],
};
