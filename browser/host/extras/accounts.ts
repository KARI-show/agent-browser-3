import { z } from "zod";
import type { ExtraFeature } from "./types";

// Stub: the feature's tools and prompt section go here (see types.ts). Keep `feature: "accounts"` on
// every tool; browser/extras/accounts.js implements them in the side panel.
void z;
export const accounts: ExtraFeature = {
  id: "accounts",
  prompt: "",
  tools: [],
};
