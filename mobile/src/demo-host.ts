import type { HostBootstrap, HostEvent, UiMessage, UiModel, UiSession } from "../../src/shared/contracts";
import type { HostActionResult } from "../../src/shared/host-protocol";
import type { HostPush, HostResponse } from "../../src/shared/host-transport";
import { createHostClient } from "../../src/workbench/host-client";
import { HostConnection, type HostTransport } from "../../src/workbench/host-connection";

const PROJECT = "demo-project";
const MODEL: UiModel = { provider: "demo", id: "sample", name: "Demo · scripted replies", billing: "local" };
const INTRO = "This is a local demonstration. These are sample conversations, not live AI output. You can send a message to try the composer; the reply is scripted. Pair your own Tau host for real agent work.";

/** An in-memory host. It has no socket, provider, filesystem or saved credentials. */
export function createDemoHost() {
  const listeners = new Set<(push: HostPush) => void>();
  let sequence = 0;
  let active = "demo-welcome";
  const now = Date.now();
  const messages = new Map<string, UiMessage[]>();
  const sessions: UiSession[] = [];
  const message = (role: UiMessage["role"], text: string): UiMessage => ({ id: crypto.randomUUID(), role, text, timestamp: Date.now() });
  const addThread = (id: string, title: string, contents: UiMessage[]) => {
    messages.set(id, contents);
    sessions.push({ id, path: id, title, modifiedAt: now, projectPath: PROJECT, workspaceId: PROJECT, projectName: "Demo project", messageCount: contents.length, modelProvider: MODEL.provider, model: MODEL.id });
  };
  addThread(active, "Welcome to Tau", [message("user", "What can I try here?"), message("assistant", INTRO)]);
  addThread("demo-pagination", "Review a pagination change", [
    message("user", "Explain this cursor pagination change."),
    message("assistant", "Sample response\n\nThe endpoint reads one extra row to check whether another page exists. Only the requested rows are returned.\n\n```typescript\nconst rows = await listItems({ limit: limit + 1, after });\nconst more = rows.length > limit;\nconst items = rows.slice(0, limit);\nreturn { items, next: more ? items.at(-1)?.id : null };\n```\n\nTry the empty result, a full page and the last page. This example does not change any files."),
  ]);
  addThread("demo-plan", "Plan a small feature", [message("user", "Outline a dark mode setting."), message("assistant", "Sample response\n\n1. Follow the system appearance by default.\n2. Add light, dark and system choices.\n3. Save the preference on the device.\n4. Check contrast and keyboard focus in both themes.\n\nYou can inspect Tau's own appearance settings from the menu.")]);
  const index = () => ({ projects: [{ path: PROJECT, workspaceId: PROJECT, name: "Demo project", lastOpenedAt: now }], sessions: sessions.map((row) => ({ ...row, messageCount: messages.get(row.id)?.length ?? 0 })) });
  const detail = (id = active) => ({ sessionId: id, messages: [...(messages.get(id) ?? [])], isStreaming: false, activeTools: [], hasMore: false });
  const catalog = () => ({ sessionId: active, models: [MODEL], model: MODEL, thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false });
  const project = { cwd: PROJECT, workspaceId: PROJECT, displayPath: "Demo project" };
  const bootstrap = (): HostBootstrap => ({ version: 1, threadIndex: index(), detail: detail(), catalog: catalog(), project });
  const updates = (): HostActionResult => ({ version: 1, updates: [
    { version: 1, type: "thread-index", index: index() },
    { version: 1, type: "catalog", catalog: catalog() },
    { version: 1, type: "project", project },
    { version: 1, type: "thread-detail", detail: detail() },
    { version: 1, type: "run", sessionId: active, event: "settled" },
  ] });
  const emit = (event: HostEvent) => { const push = { seq: ++sequence, event }; for (const listener of listeners) listener(push); };
  const reply = (id: string, text: string, identity?: unknown) => {
    const transcript = messages.get(id);
    if (!transcript) throw new Error("This demo thread does not exist.");
    if (transcript.length >= 100) throw new Error("This demo thread is full. Exit and reopen the demo to reset it.");
    const correlation = typeof identity === "string" ? { clientMessageId: identity } : identity && typeof identity === "object" ? identity : {};
    transcript.push({ ...message("user", text.slice(0, 8000)), ...correlation }, message("assistant", "Simulated reply: your message stayed on this phone. No AI model was called.\n\nIn a paired session, your Tau host runs the selected agent and sends its answer here. You can browse another sample thread or exit the demo to pair a host."));
    const row = sessions.find((entry) => entry.id === id);
    if (row) row.modifiedAt = Date.now();
    emit({ type: "thread-index", threadIndex: index() });
    emit({ type: "host-update", update: { version: 1, type: "thread-detail", detail: detail(id) } });
    emit({ type: "host-update", update: { version: 1, type: "run", sessionId: id, event: "settled" } });
  };
  let config = {};
  async function request(method: string, args: readonly unknown[]): Promise<unknown> {
    switch (method) {
      case "hello": return { protocol: 1, hostVersion: "demo", capabilities: [], resync: false, missed: [], nextSeq: sequence + 1, owner: false, host: { id: "demo", name: "Local demo" } };
      case "bootstrap": return bootstrap();
      case "switch-session": {
        const id = String(args[0]);
        if (!messages.has(id)) throw new Error("This demo thread does not exist.");
        active = id;
        return updates();
      }
      case "open-project": return updates();
      case "transcript-page": return { ...detail(String(args[0])), hasMore: false };
      case "prepared-thread-capability": return { cwd: PROJECT, generation: 0, supportsImageInput: false };
      case "prepare-prompt": return undefined;
      case "new-session": {
        if (sessions.length >= 20) throw new Error("Exit and reopen the demo to reset its threads.");
        active = crypto.randomUUID();
        addThread(active, String(args[0] || "New demo thread").slice(0, 70), []);
        if (args[0]) reply(active, String(args[0]), args[3]);
        return { ...updates(), sessionId: active, submission: { accepted: true } };
      }
      case "prompt": case "steer": case "follow-up": reply(String(args[2] || active), String(args[0] ?? ""), args[3]); return undefined;
      case "abort": return undefined;
      case "rename-thread": {
        const row = sessions.find((entry) => entry.id === (args[1] || active));
        if (row) row.title = String(args[0]).slice(0, 100);
        return updates();
      }
      case "set-model": case "set-thinking-level": case "set-mode": return updates();
      case "get-config": return config;
      case "update-config": config = { ...config, ...args[0] as object }; return config;
      case "get-config-layers": return { host: config };
      case "desktop-extensions": return { bundles: [], errors: [], skipped: [] };
      case "host-extensions": case "runtime-catalogs": case "list-user-themes": case "get-models-config": case "sync-extension-ui": return [];
      case "runtime-catalog": return undefined;
      case "environments-list": return { environments: [] };
      case "set-badge": return undefined;
      case "thread-markdown": return (messages.get(String(args[0] || active)) ?? []).map((entry) => `## ${entry.role}\n\n${entry.text}`).join("\n\n");
      default: throw new Error("This feature needs a paired Tau host. Exit the demo and connect your computer to use it.");
    }
  }
  const transport: HostTransport = {
    platform: "web",
    onPush: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    async request(method, args): Promise<HostResponse> {
      try { return { id: "demo", result: await request(method, args) }; }
      catch (error) { return { id: "demo", error: { code: "unsupported", message: error instanceof Error ? error.message : String(error) } }; }
    },
  };
  const connection = new HostConnection(transport);
  return { client: createHostClient(connection), start: () => connection.start("compact") };
}
