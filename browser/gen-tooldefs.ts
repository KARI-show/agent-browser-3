// Build-time only (run by build.mjs): turns the zod tool declarations in
// host/tools.ts into plain JSON Schema for the extension's built-in agent, so
// the API tool list is generated from the same source as the host's MCP tools.
import { z } from "zod";
import { BROWSER_SYSTEM_PROMPT, BROWSER_TOOLS } from "./host/tools";

export default {
  system: BROWSER_SYSTEM_PROMPT,
  tools: BROWSER_TOOLS.map((t) => {
    const schema = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, readOnly: t.readOnly, alwaysAsk: !!t.alwaysAsk, input_schema: schema };
  }),
};
