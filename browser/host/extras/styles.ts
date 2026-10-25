import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "styles"` on
// every tool; browser/extras/styles.js implements them in the side panel.
void z;
export const styles: ExtraFeature = {
  id: "styles",
  prompt: "",
  tools: [],
};
