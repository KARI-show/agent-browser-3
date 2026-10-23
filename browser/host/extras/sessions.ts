import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "sessions"` on
// every tool; browser/extras/sessions.js implements them in the side panel.
void z;
export const sessions: ExtraFeature = {
  id: "sessions",
  prompt: "",
  tools: [],
};
