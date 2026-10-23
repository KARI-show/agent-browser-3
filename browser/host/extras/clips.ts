import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "clips"` on
// every tool; browser/extras/clips.js implements them in the side panel.
void z;
export const clips: ExtraFeature = {
  id: "clips",
  prompt: "",
  tools: [],
};
