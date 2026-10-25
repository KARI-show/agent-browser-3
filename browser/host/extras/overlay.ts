import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "overlay"` on
// every tool; browser/extras/overlay.js implements them in the side panel.
void z;
export const overlay: ExtraFeature = {
  id: "overlay",
  prompt: "",
  tools: [],
};
