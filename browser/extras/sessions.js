// Extra feature "sessions" (side panel). Built into extras.js only for brands that switch the feature on.
// Registers its tools (declared in browser/host/extras/sessions.ts) and its UI through the registry that
// browserTools.js provides:
//   AgentBrowserTools.register("browser_x", async function (args) { return [{ type: "text", text: "…" }]; });
//   AgentBrowserTools.helpers — { currentTab, inTop(func, args, world), inAllFrames, snapshot, sleep, text }
//   AgentExtras.tabs.push({ id: "sessions", label: "📎 Label", render: async function (content, ctx) { … } });
//   AgentExtras.commands.push({ group: "…", icon: "…", name: "…", prompt: "…" });
// Nothing here may assume the DOM of other panels; build the tab's DOM without innerHTML.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("sessions")) return;
})();
