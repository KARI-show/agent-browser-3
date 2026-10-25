import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "palette"` on
// every tool; browser/extras/palette.js implements them in the side panel.
void z;
export const palette: ExtraFeature = {
  id: "palette",
  prompt: "",
  tools: [],
};
