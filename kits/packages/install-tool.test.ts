import { describe, expect, it, vi } from "vitest";
import { HostCommandError, type HostMcpTool, type HostMcpToolProvider, type HostThreadLifecycle, type HostTurnObserver, type PackageReview, type RuntimeExtensionContribution } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createPackagesHostExtension } from "./host.js";
import { newPackageTools } from "./new-package-tool.js";
import type { InstallRequest } from "./install-protocol.js";
import { PACKAGES_EXTENSION_ID } from "./protocol.js";

const review = (overrides: Partial<PackageReview> = {}): PackageReview => ({
  id: "acme.hello", name: "Hello", version: "1.0.0", description: "Says hello", directory: "/home/.tau/extensions/hello",
  permissions: ["sessions"], isolation: "worker", desktop: true, host: true, granted: false, own: false, fingerprint: "f1", buildErrors: [],
  ...overrides,
});

async function activate(reviews: Array<PackageReview | Error> = [review()]) {
  const mcp: HostMcpToolProvider[] = [];
  const runtime: RuntimeExtensionContribution[] = [];
  const lifecycles: HostThreadLifecycle[] = [];
  const observers: HostTurnObserver[] = [];
  const events: PublishedKitEvent[] = [];
  const reviewPackage = vi.fn(async (_path: string) => {
    const next = reviews.length > 1 ? reviews.shift()! : reviews[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const approvePackage = vi.fn(async (_path: string, _fingerprint: string) => review({ granted: true }));
  // The host answers true only for a package it wrote, in a thread at Full access.
  const startOwnPackage = vi.fn(async (_path: string, _fingerprint: string, _threadId: string) => false);
  const stopPackage = vi.fn(async (_id: string) => undefined);
  const kit = await activateHostKit(createPackagesHostExtension(), {
    reviewPackage, approvePackage, startOwnPackage, stopPackage,
    registerThreadLifecycle: (lifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    registerRuntimeExtension: (name, factory) => { runtime.push({ name, factory }); return () => undefined; },
    mcp: { registerTools: (tools) => { mcp.push(tools); return () => undefined; }, gate: () => () => undefined, connect: async () => undefined },
  }, (event) => events.push(event));
  // The kit also registers tau_new_package and tau_window_screenshot; this suite drives the install tool.
  const tool = (threadId: string): HostMcpTool =>
    mcp.flatMap((provider) => provider({ sessionId: threadId, cwd: "/project" }) as HostMcpTool[]).find((entry) => entry.name === "tau_install_package")!;
  const call = async (threadId: string, path: unknown, signal?: AbortSignal) =>
    JSON.parse(((await tool(threadId).execute("c1", { path }, signal, undefined, undefined as never)) as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
  const invoke = (command: string, input?: unknown) => kit.invoke(PACKAGES_EXTENSION_ID, command, input);
  const requests = async () => ((await invoke("install-requests")) as { requests: InstallRequest[] }).requests;
  const waitForCard = async () => { await vi.waitFor(async () => { if ((await requests()).length === 0) throw new Error("no card yet"); }); return (await requests())[0]!; };
  return { kit, call, invoke, requests, waitForCard, reviewPackage, approvePackage, startOwnPackage, stopPackage, runtime, lifecycles, observers, events };
}

describe("tau_install_package", () => {
  it("is a Pi tool and an MCP tool", async () => {
    const { runtime } = await activate();
    const registered: Array<{ name: string }> = [];
    await runtime.find((entry) => entry.name === "tau-install-package")!.factory({ registerTool: (tool: never) => registered.push(tool) } as never, { sessionId: "t1", cwd: "/project" });
    expect(registered.map((tool) => tool.name)).toEqual(["tau_install_package"]);
  });

  it("declares itself read-only so Ask does not confirm the call before the card does, and tau_new_package stays a write", async () => {
    const { runtime } = await activate();
    const registered: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> = [];
    await runtime.find((entry) => entry.name === "tau-install-package")!.factory({ registerTool: (tool: never) => registered.push(tool) } as never, { sessionId: "t1", cwd: "/project" });
    expect(registered[0]!.annotations).toEqual({ readOnlyHint: true });
    const newPackage = newPackageTools({ services: {} } as never)[0]!;
    expect(newPackage.annotations).toEqual({ readOnlyHint: false });
  });

  it("hands build errors back with file, line and column and shows no card", async () => {
    const { call, requests, approvePackage } = await activate([review({ buildErrors: [
      { path: "/home/.tau/extensions/hello/host.ts", message: "host.ts:3:9: Unexpected }", diagnostics: [{ file: "host.ts", line: 3, column: 9, text: "Unexpected }" }] },
      { path: "/home/.tau/extensions/hello/desktop.tsx", message: "Could not resolve" },
    ] })]);
    const result = await call("t1", "hello");
    expect(result).toMatchObject({ status: "build_failed", id: "acme.hello", errors: [{ file: "host.ts", line: 3, column: 9, message: "Unexpected }" }, { file: "desktop.tsx", message: "Could not resolve" }] });
    expect(await requests()).toEqual([]);
    expect(approvePackage).not.toHaveBeenCalled();
  });

  it("passes a refused path on to the agent as an error", async () => {
    const { call } = await activate([new HostCommandError("Only a package folder directly inside /home/.tau/extensions can be installed. Create one with tau_new_package.")]);
    await expect(call("t1", "/tmp/elsewhere")).rejects.toThrow("tau_new_package");
    await expect(call("t1", "")).rejects.toThrow("Name the package folder");
  });

  it("answers running at once for a package the user already allowed", async () => {
    const { call, requests } = await activate([review({ granted: true })]);
    expect(await call("t1", "hello")).toMatchObject({ status: "running", id: "acme.hello" });
    expect(await requests()).toEqual([]);
  });

  it("starts a package the host wrote at once when the host says the thread has Full access", async () => {
    const { call, requests, approvePackage, startOwnPackage, events } = await activate([review({ own: true })]);
    startOwnPackage.mockResolvedValueOnce(true);
    const result = await call("t1", "hello");
    expect(result).toMatchObject({ status: "running", id: "acme.hello" });
    expect(String(result.message)).toContain("Edits to its files load live");
    expect(startOwnPackage).toHaveBeenCalledWith("hello", "f1", "t1");
    expect(await requests()).toEqual([]);
    expect(approvePackage).not.toHaveBeenCalled();
    expect(events.filter((event) => event.name === "package-started").map((event) => event.payload)).toEqual([{ threadId: "t1", packageId: "acme.hello", name: "Hello", isolation: "worker" }]);
  });

  it("shows the card with the concrete data when the host does not start an own package", async () => {
    const { call, waitForCard, invoke, startOwnPackage, approvePackage, events } = await activate([review({ own: true, permissions: ["process", "network"], previous: { permissions: ["process"], isolation: "worker" } })]);
    const pending = call("t1", "hello");
    const card = await waitForCard();
    expect(startOwnPackage).toHaveBeenCalledWith("hello", "f1", "t1");
    expect(card).toMatchObject({ permissions: ["process", "network"], desktop: true, host: true, previous: { permissions: ["process"], isolation: "worker" } });
    expect(events.some((event) => event.name === "package-started")).toBe(false);
    await invoke("allow-install", { id: card.id });
    expect(approvePackage).toHaveBeenCalledWith("hello", "f1");
    expect(await pending).toMatchObject({ status: "running" });
  });

  it("asks the host to start only a package it wrote, never a foreign one", async () => {
    const { call, waitForCard, invoke, startOwnPackage } = await activate([review({ own: false })]);
    const pending = call("t1", "hello");
    await invoke("decline-install", { id: (await waitForCard()).id });
    await pending;
    expect(startOwnPackage).not.toHaveBeenCalled();
  });

  it("keeps a running own package running after an edit and says so", async () => {
    const { call, startOwnPackage } = await activate([review({ own: true, granted: true })]);
    expect(String((await call("t1", "hello")).message)).toContain("Edits to its files load live");
    expect(startOwnPackage).not.toHaveBeenCalled();
  });

  it("turns a package off only for the owner", async () => {
    const { kit, invoke, stopPackage } = await activate();
    expect(await invoke("turn-off", { id: "acme.hello" })).toEqual({ off: true });
    expect(stopPackage).toHaveBeenCalledWith("acme.hello");
    await expect(kit.invoke(PACKAGES_EXTENSION_ID, "turn-off", { id: "acme.hello" }, { kind: "workbench-client", connection: "c1", pairedClient: "phone" })).rejects.toThrow();
    expect(stopPackage).toHaveBeenCalledOnce();
  });

  it("waits on a card, never grants by itself, and returns running after the owner's Allow", async () => {
    const { call, waitForCard, invoke, approvePackage, events } = await activate();
    const pending = call("t1", "hello");
    const card = await waitForCard();
    expect(card).toMatchObject({ threadId: "t1", status: "pending", packageId: "acme.hello", name: "Hello", permissions: ["sessions"], isolation: "worker" });
    expect(approvePackage).not.toHaveBeenCalled();
    await invoke("allow-install", { id: card.id });
    expect(approvePackage).toHaveBeenCalledWith("hello", "f1");
    expect(await pending).toMatchObject({ status: "running", id: "acme.hello" });
    expect(events.filter((event) => event.name === "install-requests").at(-1)?.payload).toEqual({ requests: [] });
  });

  it("returns declined and keeps the package off", async () => {
    const { call, waitForCard, invoke, approvePackage } = await activate();
    const pending = call("t1", "hello");
    await invoke("decline-install", { id: (await waitForCard()).id });
    expect(await pending).toMatchObject({ status: "declined", id: "acme.hello" });
    expect(approvePackage).not.toHaveBeenCalled();
  });

  it("keeps the card when the grant is refused, so the user can retry or decline", async () => {
    const { call, waitForCard, invoke, approvePackage, requests } = await activate();
    approvePackage.mockRejectedValueOnce(new HostCommandError("The package was not allowed."));
    const pending = call("t1", "hello");
    const card = await waitForCard();
    await expect(invoke("allow-install", { id: card.id })).rejects.toThrow("not allowed");
    expect(await requests()).toHaveLength(1);
    await invoke("allow-install", { id: card.id });
    expect(await pending).toMatchObject({ status: "running" });
  });

  it("keeps the card and refuses a second Allow while the native confirmation is open", async () => {
    const { call, waitForCard, invoke, approvePackage, requests, kit } = await activate();
    let answer: (value: PackageReview) => void = () => undefined;
    approvePackage.mockImplementationOnce(() => new Promise<PackageReview>((resolve) => { answer = resolve; }));
    const pending = call("t1", "hello");
    const card = await waitForCard();
    // The dialog may stay open for minutes, so the command is exempt from the 30 s command timeout.
    expect(kit.longCommands()).toContain(`${PACKAGES_EXTENSION_ID}/allow-install`);
    const allowing = invoke("allow-install", { id: card.id });
    await vi.waitFor(() => expect(approvePackage).toHaveBeenCalledOnce());
    await expect(invoke("allow-install", { id: card.id })).rejects.toThrow("already open");
    expect(await requests()).toHaveLength(1);
    answer(review({ granted: true }));
    await allowing;
    expect(await pending).toMatchObject({ status: "running" });
  });

  it("ends the card when the turn is stopped, the thread is deleted or the wait runs out", async () => {
    const { call, waitForCard, requests, lifecycles } = await activate();
    const controller = new AbortController();
    const stopped = call("t1", "hello", controller.signal);
    await waitForCard();
    controller.abort();
    expect(await stopped).toMatchObject({ status: "ended" });
    expect(await requests()).toEqual([]);

    const deleted = call("t2", "hello");
    await waitForCard();
    await lifecycles[0]!.threadDeleted!("t2", "/project");
    expect(await deleted).toMatchObject({ status: "ended" });
  });

  it("lets a newer call for the same thread replace the card it left", async () => {
    const { call, waitForCard, requests } = await activate();
    const first = call("t1", "hello");
    const firstCard = await waitForCard();
    void call("t1", "hello");
    await vi.waitFor(async () => { const [card] = await requests(); if (!card || card.id === firstCard.id) throw new Error("not replaced"); });
    expect(await first).toMatchObject({ status: "ended" });
    expect(await requests()).toHaveLength(1);
  });

  it("refuses a paired device's Allow, and answers a request that ended", async () => {
    const { call, waitForCard, kit, invoke, approvePackage } = await activate();
    const pending = call("t1", "hello");
    const card = await waitForCard();
    const paired = { kind: "workbench-client", connection: "c1", pairedClient: "phone" } as const;
    await expect(kit.invoke(PACKAGES_EXTENSION_ID, "allow-install", { id: card.id }, paired)).rejects.toThrow();
    await expect(kit.invoke(PACKAGES_EXTENSION_ID, "decline-install", { id: card.id }, paired)).rejects.toThrow();
    expect(approvePackage).not.toHaveBeenCalled();
    expect(((await kit.invoke(PACKAGES_EXTENSION_ID, "install-requests", undefined, paired)) as { canManage: boolean }).canManage).toBe(false);
    await expect(invoke("allow-install", {})).rejects.toThrow("Name the request");
    await expect(invoke("allow-install", { id: "gone" })).rejects.toThrow("ended");
    await invoke("decline-install", { id: card.id });
    await pending;
  });
});
