import { describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, NewThreadClaimEvent, PlatformEnvironments, WorkbenchActions } from "tau";
import { createBringChoice, createBringProjectHook } from "./bring-project.js";

describe("starting on an older machine from a draft", () => {
  it.each(["unknown-method", "failed", "unauthorized", "timeout"])("handles %s without losing the draft or duplicating a toast", async (code) => {
    const error = Object.assign(new Error('Unknown method "start-thread".'), { code });
    const choice = createBringChoice();
    choice.set({ machine: "rex-id", machineName: "rex", projectPath: "/api", workspaceId: "ws-rex" });
    const host = { invoke: vi.fn(async () => { throw error; }), onEvent: vi.fn() } as HostExtensionClient;
    const remoteWork = { invoke: vi.fn(), onEvent: vi.fn() } as HostExtensionClient;
    const hook = createBringProjectHook(choice, remoteWork, {} as PlatformEnvironments, host);
    const actions = { toast: vi.fn(), notify: vi.fn(), switchSession: vi.fn(), openSettings: vi.fn() } as unknown as WorkbenchActions;
    const event = { projectPath: "/api", prompt: "Fix it", runtime: "pi", alternate: false, attachments: 0, preparing: vi.fn() } satisfies NewThreadClaimEvent;
    const promise = hook.claimNewThread!(event, actions);
    if (code === "unknown-method") await expect(promise).rejects.toMatchObject({ message: "rex runs an older Tau that cannot start threads yet. Update rex in Settings → Machines.", code, cause: error });
    else await expect(promise).rejects.toBe(error);
    expect(choice.get()?.machine).toBe("rex-id");
    expect(actions.switchSession).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(remoteWork.invoke).not.toHaveBeenCalled();
  });
});
