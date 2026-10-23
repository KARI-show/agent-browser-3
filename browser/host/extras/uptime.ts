import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "uptime"` on
// every tool; browser/extras/uptime.js implements them in the side panel.
void z;
export const uptime: ExtraFeature = {
  id: "uptime",
  prompt: "",
  tools: [],
};
