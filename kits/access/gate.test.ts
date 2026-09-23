import { describe, expect, it, vi } from "vitest";
import { createAccessExtension, isMutatingToolCall } from "./gate.js";

function gate(level: "read-only" | "ask" | "full", confirm: (title: string, message: string) => Promise<boolean>) {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  createAccessExtension({ level: () => level, onBlocked: () => undefined })({
    on: (_event: string, callback: typeof handler) => { handler = callback; },
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
    expect(confirm).toHaveBeenCalledWith("Approve bash?", "rm -rf build", { signal: undefined });
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
