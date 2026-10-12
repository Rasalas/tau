import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createAgentSession, createToolSearchExtension, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAccessExtension, isMutatingToolCall, toolMetadataOf } from "./gate.js";
import type { AccessLevel } from "./protocol.js";

type Registered = { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; sourceInfo: { path: string; source: string } };

function gate(level: AccessLevel, confirm: (title: string, message: string) => Promise<boolean>, registry?: Registered[]) {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  createAccessExtension({ level: () => level, onBlocked: () => undefined })({
    on: (_event: string, callback: typeof handler) => { handler = callback; },
    ...(registry ? { getAllTools: () => registry } : {}),
  } as never);
  const ctx = { ui: { confirm }, signal: undefined };
  return (toolName: string, input: Record<string, unknown>) => handler!({ type: "tool_call", toolName, toolCallId: "call", input }, ctx);
}

describe("access gate", () => {
  it("lets everything through at full access and blocks mutations when read-only", async () => {
    const confirm = vi.fn(async () => true);
    await expect(gate("full", confirm)("bash", { command: "rm -rf build" })).resolves.toBeUndefined();
    await expect(gate("read-only", confirm)("read", { path: "a" })).resolves.toBeUndefined();
    await expect(gate("read-only", confirm)("edit", { path: "a" })).resolves.toMatchObject({ block: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks through Pi's own confirm dialog and blocks a refusal", async () => {
    const confirm = vi.fn(async (_title: string, message: string) => message === "src/ok.ts");
    const ask = gate("ask", confirm);
    await expect(ask("edit", { path: "src/ok.ts" })).resolves.toBeUndefined();
    await expect(ask("bash", { command: "rm -rf build" })).resolves.toMatchObject({ block: true, reason: "Blocked by Tau: bash was not approved." });
    expect(confirm).toHaveBeenCalledWith("Wants to run", "rm -rf build", { signal: undefined });
  });

  it("allows background inspection in read-only threads and blocks starting or stopping processes", async () => {
    const confirm = vi.fn(async () => true);
    const readOnly = gate("read-only", confirm);
    await expect(readOnly("tau_background_command", { command: "npm test", label: "Tests" })).resolves.toMatchObject({ block: true });
    await expect(readOnly("tau_background_tasks", { action: "stop", taskId: "tests" })).resolves.toMatchObject({ block: true });
    await expect(readOnly("tau_background_tasks", { action: "list" })).resolves.toBeUndefined();
    await expect(readOnly("tau_background_tasks", { action: "read", taskId: "tests" })).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks at auto, since Tau has no reviewer of its own", async () => {
    const confirm = vi.fn(async () => true);
    await expect(gate("auto", confirm)("edit", { path: "a" })).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledWith("Wants to edit", "a", { signal: undefined });
  });
});

describe("isMutatingToolCall", () => {
  it("counts taking a sub-agent's work into the checkout as an edit, and Tau's other tools as reads", () => {
    expect(isMutatingToolCall("tau_apply_thread_changes", { threadId: "t" })).toBe(true);
    expect(isMutatingToolCall("tau_list_threads", {})).toBe(false);
    expect(isMutatingToolCall("preview_click", { ref: "e1" })).toBe(false);
  });


  it("keeps computer-use perception available in read-only threads", () => {
    expect(isMutatingToolCall("computer_use_get_window_state", {})).toBe(false);
    expect(isMutatingToolCall("computer_use_get_browser_state", {})).toBe(false);
    expect(isMutatingToolCall("computer_use_page", { action: "get_text" })).toBe(false);
    expect(isMutatingToolCall("computer_use_browser_dialog", { action: "inspect" })).toBe(false);
    expect(isMutatingToolCall("computer_use_check_permissions", { prompt: false })).toBe(false);
  });

  it("gates computer-use actions that can affect the desktop", () => {
    expect(isMutatingToolCall("computer_use_click", {})).toBe(true);
    expect(isMutatingToolCall("computer_use_type_text", {})).toBe(true);
    expect(isMutatingToolCall("computer_use_launch_app", {})).toBe(true);
    expect(isMutatingToolCall("computer_use_page", { action: "click_element" })).toBe(true);
    expect(isMutatingToolCall("computer_use_browser_dialog", { action: "accept" })).toBe(true);
    expect(isMutatingToolCall("computer_use_check_permissions", {})).toBe(true);
  });

  it("preserves the existing workspace mutation policy", () => {
    expect(isMutatingToolCall("read", {})).toBe(false);
    expect(isMutatingToolCall("edit", {})).toBe(true);
    expect(isMutatingToolCall("bash", {})).toBe(true);
  });
});

const fromTau = (name: string, annotations?: Registered["annotations"]): Registered => ({ name, annotations, sourceInfo: { path: "<inline:tau-preview>", source: "inline" } });
const fromProject = (name: string, annotations?: Registered["annotations"]): Registered => ({ name, annotations, sourceInfo: { path: "/project/.pi/extensions/db.ts", source: "local" } });

describe("tools from other sources", () => {
  it("asks for a foreign tool without hints and blocks it when read-only", async () => {
    const confirm = vi.fn(async () => true);
    const registry = [fromProject("query_db")];
    await expect(gate("ask", confirm, registry)("query_db", { sql: "select 1" })).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledWith("Wants to use query_db", "sql", { signal: undefined });
    await expect(gate("read-only", confirm, registry)("query_db", {})).resolves.toMatchObject({ block: true, reason: expect.stringContaining("read-only") });
    await expect(gate("full", confirm, registry)("query_db", {})).resolves.toBeUndefined();
  });

  it("lets a foreign tool run that declares itself read-only", async () => {
    const confirm = vi.fn(async () => false);
    const registry = [fromProject("query_db", { readOnlyHint: true }), fromProject("drop_db", { readOnlyHint: true, destructiveHint: true })];
    await expect(gate("read-only", confirm, registry)("query_db", {})).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    await expect(gate("ask", confirm, registry)("drop_db", {})).resolves.toMatchObject({ block: true });
  });

  it("does not believe a hint on a tool that takes a name Tau or Pi owns", async () => {
    const confirm = vi.fn(async () => false);
    const registry = [fromProject("read", { readOnlyHint: true }), fromProject("computer_use_get_window_state", { readOnlyHint: true }), fromProject("tau_list_threads", { readOnlyHint: true }), fromProject("bash", { readOnlyHint: true })];
    for (const { name } of registry) {
      await expect(gate("ask", confirm, registry)(name, {})).resolves.toMatchObject({ block: true });
    }
  });

  it("keeps Tau's own tools as they were, hints or not", async () => {
    const confirm = vi.fn(async () => false);
    const registry = [fromTau("preview_snapshot"), fromTau("tau_list_threads", { readOnlyHint: true }), fromTau("tau_apply_thread_changes", { readOnlyHint: true }), { name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } }];
    await expect(gate("read-only", confirm, registry)("preview_snapshot", {})).resolves.toBeUndefined();
    await expect(gate("read-only", confirm, registry)("tau_list_threads", {})).resolves.toBeUndefined();
    await expect(gate("read-only", confirm, registry)("read", {})).resolves.toBeUndefined();
    await expect(gate("read-only", confirm, registry)("tau_apply_thread_changes", {})).resolves.toMatchObject({ block: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("believes a Tau tool that says it mutates", () => {
    expect(isMutatingToolCall("preview_click", {}, { origin: "tau", annotations: { readOnlyHint: false } })).toBe(true);
    expect(isMutatingToolCall("preview_click", {}, { origin: "tau", annotations: { destructiveHint: true } })).toBe(true);
    expect(isMutatingToolCall("preview_snapshot", {}, { origin: "tau", annotations: { readOnlyHint: true } })).toBe(false);
  });

  it("asks when the registry cannot be read, and defers to the name policy when it has no such tool", async () => {
    const confirm = vi.fn(async () => true);
    expect(toolMetadataOf(() => { throw new Error("stale"); }, "x")).toEqual({ origin: "foreign" });
    expect(toolMetadataOf(undefined, "x")).toBeUndefined();
    expect(toolMetadataOf(() => [], "x")).toBeUndefined();
    await expect(gate("ask", confirm, [])("ghost", {})).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("reads the source off Pi's registry: only inline and core paths count as Tau's", () => {
    const meta = (tool: Registered) => toolMetadataOf(() => [tool], tool.name)?.origin;
    expect(meta(fromTau("a"))).toBe("tau");
    expect(meta({ name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } })).toBe("tau");
    expect(meta({ name: "tool_search", sourceInfo: { path: "builtin:tool-search", source: "builtin" } })).toBe("tau");
    expect(meta({ name: "mcp__docs__search", sourceInfo: { path: "builtin:mcp", source: "builtin" } })).toBe("foreign");
    expect(meta({ name: "x", sourceInfo: { path: "<sdk:x>", source: "sdk" } })).toBe("foreign");
    expect(meta({ name: "x", sourceInfo: { path: "<inline:fake>", source: "local" } })).toBe("foreign");
    expect(meta(fromProject("x"))).toBe("foreign");
  });
});

describe("deferred tools", () => {
  it("are judged by the registry before and after tool_search loads them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-gate-deferred-"));
    const tool = (name: string) => ({ name, label: name, description: `${name} tool`, parameters: Type.Object({}), exposure: "deferred" as const, execute: async () => ({ content: [], details: undefined }) });
    const kit: ExtensionFactory = (pi) => { pi.registerTool(tool("computer_use_click")); pi.registerTool(tool("preview_screenshot")); };
    try {
      const resourceLoader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: join(dir, "agent"),
        settingsManager: SettingsManager.inMemory(),
        extensionFactories: [{ name: "tau-tool-search", factory: createToolSearchExtension() }, { name: "tau-kit", factory: kit }],
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), resourceLoader, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory() });
      await session.bindExtensions({});
      try {
        const registry = () => session.getAllTools() as unknown as Registered[];
        const confirm = vi.fn(async () => false);
        // Not declared to the model yet, and already known to the gate as Tau's own.
        expect(session.getActiveToolNames()).not.toContain("computer_use_click");
        await expect(gate("read-only", confirm, registry())("computer_use_click", {})).resolves.toMatchObject({ block: true });
        await expect(gate("read-only", confirm, registry())("preview_screenshot", {})).resolves.toBeUndefined();
        await expect(gate("read-only", confirm, registry())("tool_search", { query: "click" })).resolves.toBeUndefined();
        session.setActiveToolsByName([...session.getActiveToolNames(), "computer_use_click"]);
        await expect(gate("read-only", confirm, registry())("computer_use_click", {})).resolves.toMatchObject({ block: true });
        expect(confirm).not.toHaveBeenCalled();
      } finally {
        session.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
