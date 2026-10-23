import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "snippets"` on
// every tool; browser/extras/snippets.js implements them in the side panel.
void z;
export const snippets: ExtraFeature = {
  id: "snippets",
  prompt: "",
  tools: [],
};
