import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeToolVersion, UiRuntimeBackend } from "../shared/contracts";
import { createMemoryStorage } from "../workbench/client-storage";
import { ToastStore } from "../workbench/toast-store";
import type { WorkbenchActions } from "./extension-system";
import { createRuntimeUpdateToasts, DISMISSED_UPDATES_KEY, resetOfferedUpdates, type RuntimeUpdateRun, type RuntimeUpdateToastsOptions } from "./runtime-update-toasts";

afterEach(resetOfferedUpdates);

function codex(version: Partial<RuntimeToolVersion> = {}, kind = "codex"): UiRuntimeBackend {
  return { kind, label: kind === "codex" ? "Codex" : "Codex · Work", version: { tool: "codex", installed: "0.155.0", latest: "0.156.1", updateCommand: "brew upgrade --cask codex", ...version } };
}

/** Resolves when the test says so, like a shell that ends when its command does. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(options: Partial<RuntimeUpdateToastsOptions> = {}) {
  const store = new ToastStore({ schedule: () => () => undefined });
  const storage = createMemoryStorage();
  const openSettings = vi.fn();
  const actions = { toast: store.show, openSettings } as unknown as WorkbenchActions;
  const shell = deferred<RuntimeUpdateRun>();
  const run = vi.fn(() => shell.promise);
  const recheck = vi.fn(async (): Promise<RuntimeToolVersion | undefined> => ({ tool: "codex", installed: "0.156.1", latest: "0.156.1" }));
  const toasts = createRuntimeUpdateToasts({ run, recheck, settingsPage: (backend) => backend.kind === "codex" ? "codex.settings" : "codex.settings.work", storage, ...options });
  const shown = () => store.getToasts();
  /** What the toast's button does: its action, then the toast goes unless the action keeps it. */
  const click = (label: string, index = 0) => {
    const toast = shown()[index]!;
    const action = toast.actions!.find((entry) => entry.label === label)!;
    action.run();
    if (!action.keepOpen) store.dismiss(toast.id);
  };
  return { store, storage, openSettings, actions, shell, run, recheck, toasts, shown, click };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runtime update toasts", () => {
  it("offers a newer release once per window, with Settings and Update, as T3 Code does", () => {
    const { toasts, actions, shown } = setup();
    toasts.sync([codex()], actions);
    toasts.sync([codex()], actions);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toMatchObject({
      id: "runtime-update:codex",
      type: "warning",
      title: "Update available: Codex v0.156.1",
      description: "Install the update now or review provider settings.",
      timeoutMs: 0,
    });
    expect(shown()[0]!.actions!.map((action) => action.label)).toEqual(["Settings", "Update"]);
  });

  it("offers one toast per instance and none for a current, unknown or policy-flagged version", () => {
    const { toasts, actions, shown } = setup();
    toasts.sync([
      codex(),
      codex({}, "codex@work"),
      codex({ installed: "0.156.1" }, "codex@current"),
      codex({ latest: undefined }, "codex@offline"),
      codex({ compatibility: { status: "unsafe", recommendedVersion: "0.154.0" } }, "codex@flagged"),
    ], actions);
    expect(shown().map((toast) => toast.id)).toEqual(["runtime-update:codex@work", "runtime-update:codex"]);
  });

  it("remembers a release closed with the close button on this client, and offers the next one", () => {
    const first = setup();
    first.toasts.sync([codex()], first.actions);
    first.store.dismiss("runtime-update:codex");
    expect(JSON.parse(first.storage.get(DISMISSED_UPDATES_KEY)!)).toEqual(["codex@0.156.1"]);

    // A new window on the same client: the dismissed release stays quiet, a newer one is offered.
    resetOfferedUpdates();
    const again = setup({ storage: first.storage });
    again.toasts.sync([codex()], again.actions);
    expect(again.shown()).toHaveLength(0);
    again.toasts.sync([codex({ latest: "0.157.0" })], again.actions);
    expect(again.shown()[0]!.title).toBe("Update available: Codex v0.157.0");
  });

  it("opens the instance's Providers card from Settings without remembering the release", () => {
    const { toasts, actions, click, openSettings, storage, shown } = setup();
    toasts.sync([codex({}, "codex@work")], actions);
    click("Settings");
    expect(openSettings).toHaveBeenCalledWith("codex.settings.work");
    expect(shown()).toHaveLength(0);
    expect(storage.get(DISMISSED_UPDATES_KEY)).toBeNull();
  });

  it("runs the update command only on Update, then asks the version again and says it worked", async () => {
    const { toasts, actions, click, run, recheck, shell, shown } = setup();
    toasts.sync([codex()], actions);
    expect(run).not.toHaveBeenCalled();
    click("Update");
    expect(run).toHaveBeenCalledWith("brew upgrade --cask codex", expect.objectContaining({ kind: "codex" }), actions);
    expect(shown()).toMatchObject([{ id: "runtime-update:codex", type: "loading", title: "Updating Codex", description: "Running brew upgrade --cask codex in a terminal." }]);
    // While it runs, another catalog does not bring the prompt back.
    toasts.sync([codex({ latest: "0.157.0" })], actions);
    expect(shown()).toHaveLength(1);
    expect(recheck).not.toHaveBeenCalled();

    shell.resolve({ exitCode: 0 });
    await settle();
    expect(recheck).toHaveBeenCalledWith(expect.objectContaining({ kind: "codex" }));
    expect(shown()).toMatchObject([{ id: "runtime-update:codex", type: "success", title: "Codex updated: v0.156.1", description: "New threads use the updated version." }]);
  });

  it("reports a command that failed, and one that ran but left the old version", async () => {
    const failed = setup();
    failed.toasts.sync([codex()], failed.actions);
    failed.click("Update");
    failed.shell.resolve({ exitCode: 1 });
    await settle();
    expect(failed.recheck).not.toHaveBeenCalled();
    expect(failed.shown()[0]).toMatchObject({ type: "error", title: "Codex v0.156.1 update failed", description: "brew upgrade --cask codex exited with 1; its output is in the terminal.", copyText: "brew upgrade --cask codex" });
    failed.click("Settings");
    expect(failed.openSettings).toHaveBeenCalledWith("codex.settings");

    resetOfferedUpdates();
    const unchanged = setup({ recheck: async () => ({ tool: "codex", installed: "0.155.0", latest: "0.156.1" }) });
    unchanged.toasts.sync([codex()], unchanged.actions);
    unchanged.click("Update");
    unchanged.shell.resolve({ exitCode: 0 });
    await settle();
    expect(unchanged.shown()[0]).toMatchObject({ type: "warning", title: "Codex still needs an update", description: "Codex still reports v0.155.0. Check provider settings for details." });
  });

  it("says so when the terminal closed first or could not run the command", async () => {
    const closed = setup();
    closed.toasts.sync([codex()], closed.actions);
    closed.click("Update");
    closed.shell.resolve({});
    await settle();
    expect(closed.shown()[0]).toMatchObject({ type: "warning", title: "Codex update stopped" });

    resetOfferedUpdates();
    const refused = setup({ run: async () => { throw new Error("No terminal is available to run the update in."); } });
    refused.toasts.sync([codex()], refused.actions);
    refused.click("Update");
    await settle();
    expect(refused.shown()[0]).toMatchObject({ type: "error", title: "Codex update failed", description: "No terminal is available to run the update in." });
  });

  it("offers only Settings where no terminal can run the command", () => {
    const { toasts, actions, shown } = setup({ canRun: () => false });
    toasts.sync([codex()], actions);
    expect(shown()[0]).toMatchObject({ description: "Codex can be updated from provider settings." });
    expect(shown()[0]!.actions!.map((action) => action.label)).toEqual(["Settings"]);
  });

  it("stays quiet on a client without a toast stack", () => {
    const { toasts, run } = setup();
    expect(() => toasts.sync([codex()], { openSettings: vi.fn() } as unknown as WorkbenchActions)).not.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
