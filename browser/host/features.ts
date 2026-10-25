// The feature switches a brand build can set (browser/brand.mjs mirrors these lists; a test keeps
// them equal). No imports: tools.ts, the extras and the host all read this file.
//
// Base features are on unless a brand switches one off; opt-in features ("extras", see
// browser/host/extras/) are off unless a brand switches one on. A build without a feature does not
// declare its tools to the model, leaves out its prompt section and, for the base features, drops
// the manifest permissions it owns. Tali (the default brand) has every base feature and no extras.

export const BASE_FEATURES = ["helper", "remote", "recipes", "watchers", "memory", "profiles", "cookies", "converter", "network", "proxy"] as const;
export const OPT_IN_FEATURES = ["clips", "sessions", "rewrite", "snippets", "checks", "uptime", "accounts", "audit", "styles", "palette", "elements", "overlay", "skills"] as const;
export const FEATURES = [...BASE_FEATURES, ...OPT_IN_FEATURES] as const;

export type BaseFeature = (typeof BASE_FEATURES)[number];
export type OptInFeature = (typeof OPT_IN_FEATURES)[number];
export type Feature = (typeof FEATURES)[number];
export type Features = Partial<Record<Feature, boolean>>;

export function isOptIn(f: Feature): f is OptInFeature {
  return (OPT_IN_FEATURES as readonly string[]).includes(f);
}

/** A base feature is on unless the build switched it off; an opt-in feature only when it switched it on. */
export function hasFeature(features: Features | undefined, f: Feature): boolean {
  if (isOptIn(f)) return !!features && features[f] === true;
  return !features || features[f] !== false;
}
