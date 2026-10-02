declare module "toolDefs.json" {
  const defs: {
    system: string;
    tools: Array<{ name: string; description: string; readOnly: boolean; input_schema: Record<string, unknown> }>;
  };
  export default defs;
}
