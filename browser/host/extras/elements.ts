import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "elements"` on
// every tool; browser/extras/elements.js implements them in the side panel.
void z;
export const elements: ExtraFeature = {
  id: "elements",
  prompt: "",
  tools: [],
};
