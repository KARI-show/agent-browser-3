declare module "toolDefs.json" {
  const defs: {
    system: string;
    tools: Array<{ name: string; feature?: string; description: string; readOnly: boolean; alwaysAsk?: boolean; input_schema: Record<string, unknown> }>;
  };
  export default defs;
}
