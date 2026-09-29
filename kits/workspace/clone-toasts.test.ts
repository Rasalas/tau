import { describe, expect, it, vi } from "vitest";
import type { ToastOptions, WorkbenchActions } from "tau";
import { CloneToasts, cloneProgressSummary } from "./clone-toasts.js";
import type { CloneSnapshot } from "./protocol.js";

function harness() {
  const shown: ToastOptions[] = [];
  const updates: Array<Omit<ToastOptions, "id">> = [];
  const actions = {
    notify: vi.fn(),
    openWorkspace: vi.fn(async () => true),
    toast: (options: ToastOptions) => {
      shown.push(options);
      return { id: options.id ?? "t", update: (patch: Omit<ToastOptions, "id">) => updates.push(patch), dismiss: () => undefined };
    },
  } as unknown as WorkbenchActions;
  const host = { cancelClone: vi.fn(async () => true), forgetClone: vi.fn(async () => undefined) };
  const toasts = new CloneToasts(host);
  return { shown, updates, actions, host, toasts };
}

const running = (patch: Partial<CloneSnapshot> = {}): CloneSnapshot => ({ id: "c1", name: "app", destination: "/code/app", phase: "running", stage: "connecting", ...patch });

describe("clone toasts", () => {
  it("writes progress as stage, percent and detail", () => {
    expect(cloneProgressSummary({ stage: "receiving", percent: 45, detail: "12.30 MiB | 5.00 MiB/s" })).toBe("Receiving objects · 45% · 12.30 MiB | 5.00 MiB/s");
    expect(cloneProgressSummary({ stage: "connecting" })).toBe("Connecting");
  });

  it("waits for the workbench, then updates one toast in place and cancels from it", () => {
    const { shown, updates, actions, host, toasts } = harness();
    toasts.receive(running());
    expect(shown).toEqual([]);
    toasts.bind(actions);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ id: "workspace.clone.c1", type: "loading", title: "Cloning app", description: "Connecting", timeoutMs: 0 });
    toasts.receive(running({ stage: "receiving", percent: 10 }));
    toasts.receive(running({ stage: "receiving", percent: 10 }));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ description: "Receiving objects · 10%" });
    shown[0]!.actions![0]!.run();
    expect(host.cancelClone).toHaveBeenCalledWith("c1");
  });

  it("offers the project once it is done and forgets the clone when the toast goes", async () => {
    const { shown, actions, host, toasts } = harness();
    toasts.bind(actions);
    toasts.receive(running());
    toasts.receive(running({ phase: "done", workspace: { workspaceId: "ws_app", displayPath: "/code/app" } }));
    const done = shown.at(-1)!;
    expect(done).toMatchObject({ id: "workspace.clone.c1", type: "success", title: "Cloned app", timeoutMs: 0 });
    done.actions![0]!.run();
    await Promise.resolve();
    expect(actions.openWorkspace).toHaveBeenCalledWith("ws_app");
    done.onClose?.();
    expect(host.forgetClone).toHaveBeenCalledWith("c1");
  });

  it("says what a cancel left behind and why a clone failed", () => {
    const { shown, actions, toasts } = harness();
    toasts.bind(actions);
    toasts.receive(running({ phase: "cancelled" }));
    expect(shown.at(-1)).toMatchObject({ type: "info", title: "Cancelled cloning app", description: "The partial clone was removed." });
    toasts.receive(running({ id: "c2", phase: "cancelled", leftover: "/code/app" }));
    expect(shown.at(-1)?.description).toBe("/code/app held other files and was left in place.");
    toasts.receive(running({ id: "c3", phase: "failed", error: "fatal: repository not found" }));
    expect(shown.at(-1)).toMatchObject({ type: "error", title: "Could not clone app", description: "fatal: repository not found", copyText: "fatal: repository not found" });
  });
});
