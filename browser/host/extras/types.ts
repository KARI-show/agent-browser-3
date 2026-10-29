import type { OptInFeature } from "../features";
import type { BrowserToolDef } from "../tools";

/**
 * An opt-in feature ("extra"): tools the model gets and the prompt section that explains them, in
 * builds of a brand that switches the feature on. The runtime half lives in browser/extras/<id>.js
 * (registered into the side panel by the build's extras.js). Every tool here must carry
 * `feature: <id>`; browser/host/extras/index.ts lists the features.
 */
export interface ExtraFeature {
  id: OptInFeature;
  /** A "## Heading" section for the system prompt (empty while the feature is a stub). */
  prompt: string;
  tools: BrowserToolDef[];
}
