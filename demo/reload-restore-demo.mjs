// Standalone harness mirroring the active-conversation restore logic added to
// src/extension.ts. Swaps vscode.Memento for a Map so we can watch
// save -> "reload" (fresh provider) -> ready-restore actually run.

class MemoryMemento {
  store = new Map();
  get(key, def) { return this.store.has(key) ? this.store.get(key) : def; }
  async update(key, val) { val === undefined ? this.store.delete(key) : this.store.set(key, val); }
}

// Faithful slice of ConversationStore + the provider's current/restore paths.
class Store {
  constructor(state) { this.state = state; }
  list() { return this.state.get("conversations", []); }
  get(id) { return this.list().find((c) => c.id === id); }
  async save(conv) {
    const rest = this.list().filter((c) => c.id !== conv.id);
    await this.state.update("conversations", [conv, ...rest]);
  }
}

class Provider {
  current; modelChoice = "default";
  constructor(state, conversations) { this.state = state; this.conversations = conversations; }

  // postConversations() persists the active id (the fix's "save" side).
  postConversations() {
    this.state.update("activeConversationId", this.current?.id);
  }
  openConversation(id) {
    this.current = JSON.parse(JSON.stringify(this.conversations.get(id)));
    this.postConversations();
  }
  // The "ready" handler's restore block (the fix's "restore" side).
  ready() {
    if (!this.current) {
      const lastId = this.state.get("activeConversationId");
      const last = lastId ? this.conversations.get(lastId) : undefined;
      if (last) {
        this.current = JSON.parse(JSON.stringify(last));
        if (last.model) this.modelChoice = last.model;
      }
    }
    return this.current
      ? { type: "loadConversation", title: this.current.title, messages: this.current.messages }
      : { type: "clear" };
  }
}

const state = new MemoryMemento();
const store = new Store(state);
await store.save({ id: "convA", title: "Refactor auth", model: "opus", messages: [{ kind: "user", text: "hi" }] });
await store.save({ id: "convB", title: "Fix reload bug", model: "sonnet", messages: [{ kind: "user", text: "yo" }] });

console.log("STEP 1  user opens conversation convB");
let provider = new Provider(state, store);
provider.openConversation("convB");
console.log("        active:", provider.current.id, "| persisted id:", state.get("activeConversationId"));

console.log("\nSTEP 2  WINDOW RELOAD  -> brand-new provider, current is undefined");
provider = new Provider(state, store);     // host restarted: in-memory current is gone
console.log("        provider.current before ready:", provider.current);

console.log("\nSTEP 3  webview sends 'ready' -> restore runs");
const sent = provider.ready();
console.log("        posted to webview:", JSON.stringify(sent));
console.log("        model restored   :", provider.modelChoice);

console.log("\nBEFORE fix: ready() saw current=undefined -> posted {type:'clear'} -> blank panel.");
console.log("AFTER  fix: restored ===", sent.type === "loadConversation" && sent.title === "Fix reload bug");
