import { describe, expect, it, vi } from "vitest";
import type { HostClientCall } from "../shared/host-transport.js";
import { ClientCalls, PINNED_WINDOW_GONE } from "./client-calls.js";
import { runAsCaller } from "./host-invocation.js";
import { WindowExtensionRegistry } from "./window-extensions.js";

interface Sent extends HostClientCall { to: string }

function calls(timeoutMs = 50): { calls: ClientCalls; sent: Sent[] } {
  const sent: Sent[] = [];
  const instance = new ClientCalls((to, call) => { sent.push({ ...call, to }); return true; }, timeoutMs);
  return { calls: instance, sent };
}

const PREVIEW = "tau.preview";
/** The window process beside the host: loopback, host token, halves. */
const hostWindow = { local: true, windowId: "w-host", windowHalves: [PREVIEW, "window"] };

describe("calls from the host into a client's process", () => {
  it("sends one call to the window on this machine and resolves with its answer", async () => {
    const { calls: pending, sent } = calls();
    pending.attach("win", hostWindow);
    pending.attach("page", { local: true });
    const answer = pending.call(PREVIEW, "open-view", { url: "about:blank" });

    expect(sent).toEqual([expect.objectContaining({ to: "win", extensionId: PREVIEW, command: "open-view", input: { url: "about:blank" } })]);
    pending.settle(sent[0]!.callId, { ok: true }, undefined, "win");
    await expect(answer).resolves.toEqual({ ok: true });
  });

  it("fails the call when the window reports an error", async () => {
    const { calls: pending, sent } = calls();
    pending.attach("win", hostWindow);
    const answer = pending.call(PREVIEW, "open-view");
    pending.settle(sent[0]!.callId, undefined, "This window cannot draw a preview.", "win");
    await expect(answer).rejects.toThrow(/cannot draw a preview/u);
  });

  it("fails at once when no window has the half", async () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("page", { local: true });
    pending.attach("win", { ...hostWindow, windowHalves: ["window"] });
    await expect(pending.call(PREVIEW, "open-view")).rejects.toThrow(/No Tau window on this host has the window half of tau.preview/u);
    expect(sent).toEqual([]);
  });

  it("gives up when the window never answers", async () => {
    const { calls: pending } = calls(10);
    pending.attach("win", hostWindow);
    await expect(pending.call(PREVIEW, "open-view")).rejects.toThrow(/No window answered/u);
  });

  it("drops an answer from any connection but the addressee", async () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("win", hostWindow);
    pending.attach("phone", { local: false, pairedClient: "c1", windowHalves: ["window"] });
    const answer = pending.pickDirectory();
    const { callId } = sent[0]!;

    pending.settle(callId, "/forged", undefined, "phone");
    pending.settle(callId, "/forged", undefined, undefined);
    pending.settle(callId, "/chosen", undefined, "win");
    await expect(answer).resolves.toBe("/chosen");
  });

  it("ignores an answer to a call it does not know", () => {
    const { calls: pending } = calls();
    expect(() => pending.settle("never-asked", "x", undefined, "win")).not.toThrow();
  });

  it("fails what a window was asked when it disconnects", async () => {
    const { calls: pending } = calls(10_000);
    pending.attach("win", hostWindow);
    const answer = pending.call(PREVIEW, "open-view");
    pending.detach("win");
    await expect(answer).rejects.toThrow(/disconnected/u);
    await expect(pending.call(PREVIEW, "open-view")).rejects.toThrow(/No Tau window/u);
  });

  it("fails at once when the connection cannot be written to", async () => {
    const pending = new ClientCalls(() => false, 10_000);
    pending.attach("win", hostWindow);
    await expect(pending.call(PREVIEW, "open-view")).rejects.toThrow(/disconnected/u);
  });

  it("fails everything still waiting when the host stops", async () => {
    const { calls: pending } = calls(10_000);
    pending.attach("win", hostWindow);
    const answer = pending.call(PREVIEW, "open-view");
    pending.dispose();
    await expect(answer).rejects.toThrow(/stopped waiting/u);
  });
});

describe("which connection a call goes to", () => {
  it("goes to the window of the renderer whose request caused it", () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("win", hostWindow);
    pending.attach("mac-window", { local: false, windowId: "w-mac", windowHalves: [PREVIEW] });
    pending.attach("mac-page", { local: false, windowId: "w-mac" });
    void pending.call(PREVIEW, "open-view", undefined, {}, "mac-page").catch(() => undefined);
    void pending.call(PREVIEW, "open-view", undefined, {}, "mac-window").catch(() => undefined);
    expect(sent.map((call) => call.to)).toEqual(["mac-window", "mac-window"]);
  });

  it("falls back to the window on this machine when the caller has no half", () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("win", hostWindow);
    pending.attach("browser", { local: false, pairedClient: "c1" });
    void pending.call(PREVIEW, "open-view", undefined, {}, "browser").catch(() => undefined);
    expect(sent.map((call) => call.to)).toEqual(["win"]);
  });

  it("never sends a paired client a call it did not cause", async () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("phone", { local: true, pairedClient: "c1", windowId: "w-phone", windowHalves: [PREVIEW, "window"] });
    await expect(pending.call(PREVIEW, "open-view")).rejects.toThrow(/No Tau window/u);
    await expect(pending.call(PREVIEW, "open-view", undefined, {}, "someone-else")).rejects.toThrow(/No Tau window/u);
    expect(sent).toEqual([]);

    void pending.call(PREVIEW, "open-view", undefined, {}, "phone").catch(() => undefined);
    expect(sent.map((call) => call.to)).toEqual(["phone"]);
  });

  it("does not lend a window to a renderer holding another credential", () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("win", hostWindow);
    // Claims the host window's id, but said hello with a paired client's token.
    pending.attach("impostor", { local: true, pairedClient: "c1", windowId: "w-host" });
    void pending.call(PREVIEW, "open-view", undefined, { callerOnly: true }, "impostor").catch(() => undefined);
    expect(sent).toEqual([]);
  });

  it("ignores a remote host-token window unless it is the caller's", () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("remote", { local: false, windowId: "w-remote", windowHalves: [PREVIEW] });
    void pending.call(PREVIEW, "open-view").catch(() => undefined);
    expect(sent).toEqual([]);
  });

  it("asks the newest of two windows on this machine, and only it", () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("first", hostWindow);
    pending.attach("second", { ...hostWindow, windowId: "w-second" });
    void pending.call(PREVIEW, "open-view").catch(() => undefined);
    expect(sent.map((call) => call.to)).toEqual(["second"]);
  });

  it("shows the folder picker only in the caller's window", async () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("win", hostWindow);
    pending.attach("page", { local: true, windowId: "w-host" });
    pending.attach("browser", { local: false, pairedClient: "c1" });

    await expect(pending.pickDirectory(undefined, "browser")).rejects.toThrow(/no window that can answer/u);
    expect(sent).toEqual([]);
    void pending.pickDirectory(undefined, "page");
    expect(sent.map((call) => call.to)).toEqual(["win"]);
    // A call the host makes for itself has no caller: its own window answers.
    void pending.pickDirectory(undefined, undefined);
    expect(sent.map((call) => call.to)).toEqual(["win", "win"]);
  });

  it("takes the caller from the request that is running, and only while it runs", async () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("win", hostWindow);
    pending.attach("mac-window", { local: false, windowId: "w-mac", windowHalves: [PREVIEW] });
    pending.attach("mac-page", { local: false, windowId: "w-mac" });
    const principal = { kind: "workbench-client", connection: "mac-page" } as const;

    let later: (() => void) | undefined;
    await runAsCaller(principal, async () => {
      await Promise.resolve();
      void pending.call(PREVIEW, "during").catch(() => undefined);
      later = () => void pending.call(PREVIEW, "after").catch(() => undefined);
    });
    later?.();
    expect(sent.map((call) => [call.command, call.to])).toEqual([["during", "mac-window"], ["after", "win"]]);
  });
});

describe("calls for what lives on the host's machine", () => {
  it("skips the caller's window on another machine and asks the one on the host", () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("win", hostWindow);
    pending.attach("mac-window", { local: false, windowId: "w-mac", windowHalves: [PREVIEW] });
    pending.attach("mac-page", { local: false, windowId: "w-mac" });
    void pending.call(PREVIEW, "open-view", undefined, { window: "host" }, "mac-page").catch(() => undefined);
    expect(sent.map((call) => call.to)).toEqual(["win"]);
  });

  it("keeps the caller's own window when it is on the host's machine", () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("first", hostWindow);
    pending.attach("first-page", { local: true, windowId: "w-host" });
    pending.attach("second", { ...hostWindow, windowId: "w-second" });
    void pending.call(PREVIEW, "open-view", undefined, { window: "host" }, "first-page").catch(() => undefined);
    expect(sent.map((call) => call.to)).toEqual(["first"]);
  });

  it("names the window it would reach, never a paired client's", () => {
    const { calls: pending } = calls(10_000);
    pending.attach("phone", { local: true, pairedClient: "c1", windowId: "w-phone", windowHalves: [PREVIEW] });
    expect(pending.clientWindow(PREVIEW, "phone")).toBeUndefined();
    pending.attach("win", hostWindow);
    expect(pending.clientWindow(PREVIEW, "phone")).toBe("w-host");
    expect(pending.clientWindow(PREVIEW)).toBe("w-host");
  });

  it("sends a pinned call to that window whoever asks, and after it reconnects", () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("first", hostWindow);
    pending.attach("second", { ...hostWindow, windowId: "w-second" });
    void pending.call(PREVIEW, "place", undefined, { window: "w-host" }).catch(() => undefined);
    void pending.call(PREVIEW, "place", undefined, { window: "w-host" }, "second").catch(() => undefined);
    pending.detach("first");
    pending.attach("first-again", hostWindow);
    void pending.call(PREVIEW, "place", undefined, { window: "w-host" }).catch(() => undefined);
    expect(sent.map((call) => call.to)).toEqual(["first", "first", "first-again"]);
  });

  it("rejects a pinned call at once when that window is gone, and never pins a paired client", async () => {
    const { calls: pending, sent } = calls(10_000);
    pending.attach("second", { ...hostWindow, windowId: "w-second" });
    pending.attach("impostor", { local: true, pairedClient: "c1", windowId: "w-host", windowHalves: [PREVIEW] });
    await expect(pending.call(PREVIEW, "place", undefined, { window: "w-host" })).rejects.toThrow(PINNED_WINDOW_GONE);
    expect(sent).toEqual([]);
  });
});

describe("the window half registry", () => {
  const registry = () => new WindowExtensionRegistry({ invokeHost: async () => undefined });

  it("routes a call to the half that belongs to the extension", async () => {
    const instance = registry();
    instance.register("tau.preview", () => ({ handle: (command, input) => ({ command, input }) }));
    await expect(instance.invoke("tau.preview", "place", { x: 1 })).resolves.toEqual({ command: "place", input: { x: 1 } });
  });

  it("says so when this window has no such half", async () => {
    await expect(registry().invoke("tau.absent", "place")).rejects.toThrow(/no half of tau.absent/u);
  });

  it("lends a half Tau's own dependencies by package name, never by path", async () => {
    const loaded: string[] = [];
    const instance = new WindowExtensionRegistry({ invokeHost: async () => undefined, loadDependency: async (name) => { loaded.push(name); return { name }; } });
    let context: Parameters<Parameters<typeof instance.register>[1]>[0] | undefined;
    instance.register("tau.snapshots", (given) => { context = given; return { handle: () => undefined }; });
    await expect(context?.loadDependency?.("@crowecawcaw/xa11y")).resolves.toEqual({ name: "@crowecawcaw/xa11y" });
    expect(loaded).toEqual(["@crowecawcaw/xa11y"]);

    const real = new WindowExtensionRegistry({ invokeHost: async () => undefined });
    real.register("tau.snapshots", (given) => { context = given; return { handle: () => undefined }; });
    await expect(context?.loadDependency?.("../secrets.js")).rejects.toThrow(/not a package name/u);
  });

  it("lets every half go when the window does", () => {
    const instance = registry();
    let disposed = false;
    instance.register("tau.preview", () => ({ handle: () => undefined, dispose: () => { disposed = true; } }));
    instance.dispose();
    expect(disposed).toBe(true);
    expect(instance.ids).toEqual([]);
  });
});

describe("a window started on demand", () => {
  function launcher(onEnsure: () => void = () => undefined) {
    const log: string[] = [];
    return { log, launcher: { ensure: async () => { log.push("ensure"); onEnsure(); }, activity: () => { log.push("activity"); } } };
  }

  it("starts the display's window when no window is attached, then asks it", async () => {
    const { calls: pending, sent } = calls(10_000);
    const { log, launcher: display } = launcher(() => { queueMicrotask(() => pending.attach("win", hostWindow)); });
    pending.setWindowLauncher(display);
    const answer = pending.call(PREVIEW, "live-frame", undefined, {}, "phone");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ to: "win", command: "live-frame" });
    pending.settle(sent[0]!.callId, "frame", undefined, "win");
    await expect(answer).resolves.toBe("frame");
    expect(log).toEqual(["ensure", "activity", "activity"]);
  });

  it("says so when the window it started has no such half, or never connects", async () => {
    const { calls: pending, sent } = calls(10_000);
    pending.setWindowLauncher(launcher(() => { queueMicrotask(() => pending.attach("win", { ...hostWindow, windowHalves: ["window"] })); }).launcher);
    await expect(pending.call(PREVIEW, "open-view")).rejects.toThrow(/No Tau window on this host has the window half of tau.preview/u);

    const idle = calls(10_000);
    idle.calls.setWindowLauncher(launcher().launcher, 5);
    await expect(idle.calls.call(PREVIEW, "open-view")).rejects.toThrow(/did not connect within/u);
    expect([...sent, ...idle.sent]).toEqual([]);
  });

  it("never starts one for a pinned window or a call only the caller's own window may answer", async () => {
    const { calls: pending } = calls(10_000);
    const { log, launcher: display } = launcher();
    pending.setWindowLauncher(display);
    await expect(pending.call(PREVIEW, "open-view", undefined, { window: "w-gone" })).rejects.toThrow(PINNED_WINDOW_GONE);
    await expect(pending.pickDirectory(undefined, "phone")).rejects.toThrow(/open it in the Tau desktop app/u);
    expect(log).toEqual([]);
  });

  it("does not count a paired device's window as activity on this machine", async () => {
    const { calls: pending, sent } = calls(10_000);
    const { log, launcher: display } = launcher();
    pending.setWindowLauncher(display);
    pending.attach("phone", { local: false, pairedClient: "c1", windowHalves: [PREVIEW] });
    const answer = pending.call(PREVIEW, "open-view", undefined, {}, "phone");
    pending.settle(sent[0]!.callId, true, undefined, "phone");
    await expect(answer).resolves.toBe(true);
    expect(log).toEqual([]);
  });
});
