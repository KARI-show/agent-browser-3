// The opt-in features, one module each; tools.ts appends their tools and prompt sections to the
// base set. Adding one: a module here, its runtime in browser/extras/<id>.js, its id in
// browser/host/features.ts OPT_IN_FEATURES and browser/brand.mjs OPT_IN_FEATURES.
import type { ExtraFeature } from "./types";
import { clips } from "./clips";
import { sessions } from "./sessions";
import { rewrite } from "./rewrite";
import { snippets } from "./snippets";
import { checks } from "./checks";
import { uptime } from "./uptime";
import { accounts } from "./accounts";
import { audit } from "./audit";
import { styles } from "./styles";
import { palette } from "./palette";
import { elements } from "./elements";
import { overlay } from "./overlay";
import { skills } from "./skills";

export const EXTRAS: ExtraFeature[] = [clips, sessions, rewrite, snippets, checks, uptime, accounts, audit, styles, palette, elements, overlay, skills];
export type { ExtraFeature } from "./types";
