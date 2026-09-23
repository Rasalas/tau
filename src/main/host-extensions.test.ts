import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GlobalHostEvent } from "../shared/contracts.js";
import { HostCommandError } from "./host-extension-errors.js";
import { HostExtensionRegistry, type HostExtension, type HostExtensionServices } from "./host-extensions.js";
import { WORKBENCH_CLIENT_PRINCIPAL } from "./host-invocation.js";
import { TurnAttachmentRegistry } from "./turn-attachments.js";

function services(): HostExtensionServices & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    cwd: () => "/project",
    agentDir: "/agent",
    sessionsDir: "/agent/sessions",
    stateDir: "/state",
    themesDir: "/themes",
    safeMode: false,
    log: (label, detail) => { logs.push(detail ? `${label} ${detail}` : label); },
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    admitWorkspace: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: () => undefined,
    complete: async () => "",
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    skills: () => [],
    refreshExtensionPackages: async () => undefined,
    listPackages: async () => [],
    installPackage: async () => { throw new Error("no installer in this test"); },
    removePackage: async () => { throw new Error("no installer in this test"); },
    updatePackages: async () => [],
    sessions: {
      list: async () => [],
      open: () => { throw new Error("no sessions in this test"); },
      prepare: async () => { throw new Error("no sessions in this test"); },
      start: async () => { throw new Error("no threads in this test"); },
      remove: async () => undefined, restore: async () => undefined, trash: async () => [], purge: async () => undefined,
      exclusive: (work) => work(),
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    clients: { observe: () => () => undefined, count: () => 0 },
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    loadRuntimeExtension: async () => { throw new Error("no runtime packages in this test"); },
    loadDependency: async () => { throw new Error("no dependencies in this test"); },
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, connect: async () => undefined },
    callClient: async () => { throw new Error("no client in this test"); },
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    observeConfigChanges: () => () => undefined,
    presentUi: () => () => undefined,
  };
}

function registry() {
  const events: GlobalHostEvent[] = [];
  const s = services();
  return { registry: new HostExtensionRegistry(s, (event) => events.push(event)), events, services: s };
}

describe("HostExtensionRegistry", () => {
  it("routes commands by extension id and command name", async () => {
    const { registry: r } = registry();
    const extension: HostExtension = {
      id: "demo.kit",
      name: "Demo Kit",
      activate: (ctx) => { ctx.registerCommand("echo", (input) => ({ input })); },
    };
    await expect(r.activate(extension)).resolves.toBe(true);
    await expect(r.invoke("demo.kit", "echo", { a: 1 })).resolves.toEqual({ input: { a: 1 } });
    expect(r.summaries()).toEqual([{ id: "demo.kit", name: "Demo Kit", active: true, commands: ["echo"], isolation: "in-process" }]);
  });

  it("rejects unknown extensions and commands with a readable reason", async () => {
    const { registry: r } = registry();
    await r.activate({ id: "demo.kit", name: "Demo Kit", activate: (ctx) => { ctx.registerCommand("echo", () => 1); } });
    await expect(r.invoke("other.kit", "echo")).rejects.toThrow("Host extension other.kit is not installed.");
    await expect(r.invoke("demo.kit", "missing")).rejects.toThrow('Host extension Demo Kit has no command "missing".');
    await r.deactivate("demo.kit");
    await expect(r.invoke("demo.kit", "echo")).rejects.toThrow("Host extension Demo Kit is not active.");
  });

  it("publishes extension events only while the extension is active", async () => {
    const { registry: r, events } = registry();
    let emit: ((name: string, payload?: unknown) => void) | undefined;
    await r.activate({ id: "demo.kit", name: "Demo Kit", activate: (ctx) => { emit = ctx.emit; } });
    emit?.("changed", { path: "a" });
    await r.deactivate("demo.kit");
    emit?.("changed", { path: "b" });
    expect(events).toEqual([{ type: "extension-event", extensionId: "demo.kit", name: "changed", payload: { path: "a" } }]);
  });

  it("records an activation failure without throwing, and runs partial cleanup", async () => {
    const { registry: r, services: s } = registry();
    const dispose = vi.fn();
    const ok = await r.activate({
      id: "broken.kit",
      name: "Broken Kit",
      activate: (ctx) => {
        const off = ctx.registerCommand("echo", () => 1);
        dispose.mockImplementation(off);
        throw new Error("boom");
      },
    });
    expect(ok).toBe(false);
    expect(r.isActive("broken.kit")).toBe(false);
    expect(r.summaries()).toEqual([{ id: "broken.kit", name: "Broken Kit", active: false, commands: [], isolation: "in-process", error: "boom" }]);
    expect(s.logs.some((line) => line.startsWith("host-extension.failed"))).toBe(true);
  });

  it("refuses invalid ids and command names", async () => {
    const { registry: r } = registry();
    expect(await r.activate({ id: "Bad Id", name: "x", activate: () => undefined })).toBe(false);
    expect(await r.activate({ id: "demo.kit", name: "x", activate: (ctx) => { ctx.registerCommand("Not Valid", () => 1); } })).toBe(false);
    expect(r.summaries().find((entry) => entry.id === "demo.kit")?.error).toContain("invalid command name");
  });

  it("runs disposers in reverse order on deactivate and dispose", async () => {
    const { registry: r } = registry();
    const order: string[] = [];
    await r.activate({ id: "a.kit", name: "A", activate: () => () => { order.push("a"); } });
    await r.activate({ id: "b.kit", name: "B", activate: () => async () => { order.push("b"); } });
    await r.dispose();
    expect(order).toEqual(["b", "a"]);
    expect(r.summaries().every((entry) => !entry.active)).toBe(true);
  });

  it("gives every extension its own state folder under the root, without creating it", async () => {
    const { registry: r } = registry();
    const seen: string[] = [];
    const kit = (id: string): HostExtension => ({
      id,
      name: id,
      permissions: [],
      activate: (ctx) => { seen.push(ctx.services.stateDir); },
    });
    await r.activate(kit("one.kit"));
    await r.activate(kit("two.kit"));
    expect(seen).toEqual([join("/state", "one.kit"), join("/state", "two.kit")]);
    expect(existsSync(join("/state", "one.kit"))).toBe(false);
  });

  it("binds turn attachments and settings to the extension that asks", async () => {
    const attachments = new TurnAttachmentRegistry();
    const settings = vi.fn(async (extensionId: string, cwd?: string) => ({ options: { [extensionId]: true }, values: { cwd: cwd ?? "" } }));
    const r = new HostExtensionRegistry({ ...services(), turnAttachments: attachments as never, settings: settings as never }, () => undefined);
    const seen: Record<string, unknown> = {};
    await r.activate({
      id: "maker.kit",
      name: "Maker",
      permissions: ["sessions"],
      activate: async (ctx) => {
        ctx.services.turnAttachments?.provide({
          list: () => [{ id: "f1", at: 1, mediaType: "image/jpeg", size: 3 }],
          read: async () => ({ mediaType: "image/jpeg", data: "abc" }),
        });
        seen.settings = await ctx.services.settings?.("/project");
      },
    });
    await r.activate({
      id: "reader.kit",
      name: "Reader",
      permissions: ["sessions"],
      activate: async (ctx) => {
        seen.list = await ctx.services.turnAttachments?.list("t1");
        seen.read = await ctx.services.turnAttachments?.read("t1", "maker.kit", "f1");
      },
    });
    await r.activate({ id: "blind.kit", name: "Blind", permissions: [], activate: (ctx) => { seen.blind = (() => { try { return ctx.services.turnAttachments; } catch (error) { return String(error); } })(); } });

    expect(seen.settings).toEqual({ options: { "maker.kit": true }, values: { cwd: "/project" } });
    expect(seen.list).toEqual([{ id: "f1", source: "maker.kit", at: 1, mediaType: "image/jpeg", size: 3 }]);
    expect(seen.read).toEqual({ mediaType: "image/jpeg", data: "abc" });
    expect(seen.blind).toContain("lacks permission sessions");
  });

  it("enforces permissions on HostExtensionServices methods", async () => {
    const { registry: r, services: s } = registry();
    // Extension with empty permissions tries to access sessions.list()
    const deniedExt: HostExtension = {
      id: "denied.kit",
      name: "Denied Kit",
      permissions: [],
      activate: (ctx) => {
        ctx.registerCommand("call-sessions", () => ctx.services.sessions.list());
      },
    };
    await expect(r.activate(deniedExt)).resolves.toBe(true);
    await expect(r.invoke("denied.kit", "call-sessions")).rejects.toThrow("Extension denied.kit lacks permission sessions");
    expect(s.logs).toContain("host-extension.denied Extension denied.kit lacks permission sessions");

    // Extension with permissions: ["sessions"] can access sessions.list()
    const allowedExt: HostExtension = {
      id: "allowed.kit",
      name: "Allowed Kit",
      permissions: ["sessions"],
      activate: (ctx) => {
        ctx.registerCommand("call-sessions", () => ctx.services.sessions.list());
      },
    };
    await expect(r.activate(allowedExt)).resolves.toBe(true);
    await expect(r.invoke("allowed.kit", "call-sessions")).resolves.toEqual([]);

    // The same guard covers workspace switching, not only sessions.
    const switcher: HostExtension = {
      id: "switch.kit",
      name: "Switch Kit",
      permissions: [],
      activate: (ctx) => {
        ctx.registerCommand("open", () => ctx.services.openWorkspace("/tmp"));
      },
    };
    await expect(r.activate(switcher)).resolves.toBe(true);
    await expect(r.invoke("switch.kit", "open")).rejects.toThrow("Extension switch.kit lacks permission workspace:switch");
    expect(s.logs).toContain("host-extension.denied Extension switch.kit lacks permission workspace:switch");

    // Bundled extension with undefined permissions has access to everything
    const legacyExt: HostExtension = {
      id: "legacy.kit",
      name: "Legacy Kit",
      activate: (ctx) => {
        ctx.registerCommand("open", () => ctx.services.openWorkspace("/tmp"));
      },
    };
    await expect(r.activate(legacyExt)).resolves.toBe(true);
    await expect(r.invoke("legacy.kit", "open")).resolves.toEqual({ version: 1, updates: [] });
  });

  it("does not count repeated permission denials as handler crashes", async () => {
    const { registry: r, services: s, events } = registry();
    await r.activate({
      id: "denied.kit",
      name: "Denied Kit",
      permissions: [],
      activate: (ctx) => {
        ctx.registerCommand("call-sessions", () => ctx.services.sessions.list());
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(r.invoke("denied.kit", "call-sessions")).rejects.toThrow("Extension denied.kit lacks permission sessions");
    }
    expect(r.isActive("denied.kit")).toBe(true);
    expect(s.logs.filter((line) => line.startsWith("host-extension.denied"))).toHaveLength(3);
    expect(events.filter((event) => event.type === "extension-deactivated")).toEqual([]);
  });

  it("authorizes host-issued callers per declared command and rejects forged contexts", async () => {
    const { registry: r, services: s } = registry();
    let reviewContextId = "";
    let reviewInvoke: ((extensionId: string, command: string, input?: unknown) => Promise<unknown>) | undefined;
    await r.activate({
      id: "tau.workspace",
      name: "Workspace Kit",
      permissions: [],
      activate: (ctx) => {
        ctx.registerCommand("changes", () => "read", { callers: ["tau.review"] });
        ctx.registerCommand("pick-folder", () => "restricted");
      },
    });
    await r.activate({
      id: "tau.review",
      name: "Review Kit",
      permissions: [],
      activate: (ctx) => {
        reviewContextId = ctx.invocationContextId;
        reviewInvoke = ctx.invokeHostExtension;
      },
    });

    expect(reviewInvoke).toBeDefined();
    const invokeFromReview = reviewInvoke as (extensionId: string, command: string, input?: unknown) => Promise<unknown>;
    await expect(invokeFromReview("tau.workspace", "changes")).resolves.toBe("read");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(invokeFromReview("tau.workspace", "pick-folder")).rejects.toMatchObject({
        name: "HostAuthorizationError",
        code: "unauthorized",
        details: { caller: "tau.review", target: "tau.workspace", command: "pick-folder", capability: "tau.workspace/pick-folder" },
      });
    }
    expect(r.isActive("tau.workspace")).toBe(true);
    expect(s.logs.some((line) => line.includes('host-extension.denied {"caller":"tau.review","target":"tau.workspace","command":"pick-folder"'))).toBe(true);

    await expect(r.invoke("tau.workspace", "pick-folder", { callerId: "tau.review" }, {
      kind: "host-extension",
      contextId: "forged-context",
    })).rejects.toMatchObject({ name: "HostAuthorizationError", code: "unauthorized" });
    expect(s.logs.some((line) => line.includes('host-extension.denied {"caller":"unknown","target":"tau.workspace","command":"pick-folder"'))).toBe(true);

    // The authenticated renderer is the one trusted workbench principal. Its
    // legacy owner calls remain compatible, regardless of command input.
    await expect(r.invoke("tau.workspace", "pick-folder", { callerId: "tau.untrusted" }, WORKBENCH_CLIENT_PRINCIPAL)).resolves.toBe("restricted");

    const expiredInvoke = invokeFromReview;
    const expiredContextId = reviewContextId;
    await r.deactivate("tau.review");
    await expect(expiredInvoke("tau.workspace", "changes")).rejects.toMatchObject({
      name: "HostAuthorizationError",
      code: "unauthorized",
      details: { caller: "unknown", target: "tau.workspace", command: "changes" },
    });
    await expect(r.activateKnown("tau.review")).resolves.toBe(true);
    expect(reviewContextId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(reviewContextId).not.toBe(expiredContextId);
    await expect(expiredInvoke("tau.workspace", "changes")).rejects.toMatchObject({ name: "HostAuthorizationError", code: "unauthorized" });
    expect(reviewInvoke).toBeDefined();
    await expect(reviewInvoke!("tau.workspace", "changes")).resolves.toBe("read");
  });

  it("deactivates an extension when a command times out", async () => {
    const s = services();
    const events: GlobalHostEvent[] = [];
    const r = new HostExtensionRegistry(s, (event) => events.push(event), { commandTimeoutMs: 50 });
    // A promise that only resolves when the test explicitly releases it, so no
    // real timer lingers in the background after the command times out.
    let releaseHang!: () => void;
    await r.activate({
      id: "slow.kit",
      name: "Slow Kit",
      activate: (ctx) => {
        ctx.registerCommand("hang", () => new Promise<void>((resolve) => { releaseHang = resolve; }));
      },
    });
    await expect(r.invoke("slow.kit", "hang")).rejects.toThrow("timed out after 50ms");
    releaseHang(); // let the dangling promise settle cleanly
    expect(r.isActive("slow.kit")).toBe(false);
    expect(r.summaries().find((e) => e.id === "slow.kit")?.error).toBe('command "hang" timed out after 50ms');
    expect(s.logs.some((line) => line.includes("host-extension.failed") && line.includes("timed out"))).toBe(true);
    // One announcement, so the client raises exactly one toast for it.
    expect(events.filter((event) => event.type === "extension-deactivated")).toEqual([
      { type: "extension-deactivated", extensionId: "slow.kit", name: "Slow Kit", reason: expect.stringContaining("timed out after 50ms") },
    ]);
  });

  it("deactivates an extension after 3 consecutive failures", async () => {
    const { registry: r, events } = registry();
    let fails = true;
    await r.activate({
      id: "flaky.kit",
      name: "Flaky Kit",
      activate: (ctx) => {
        ctx.registerCommand("flaky", () => {
          if (fails) throw new Error("failure");
          return "ok";
        });
      },
    });

    // 1st failure
    await expect(r.invoke("flaky.kit", "flaky")).rejects.toThrow("failure");
    expect(r.isActive("flaky.kit")).toBe(true);

    // 2nd failure
    await expect(r.invoke("flaky.kit", "flaky")).rejects.toThrow("failure");
    expect(r.isActive("flaky.kit")).toBe(true);

    // 3rd failure -> deactivates!
    await expect(r.invoke("flaky.kit", "flaky")).rejects.toThrow("failure");
    expect(r.isActive("flaky.kit")).toBe(false);
    expect(r.summaries().find((e) => e.id === "flaky.kit")?.error).toBe("failed three times in a row — failure");
    expect(events.filter((event) => event.type === "extension-deactivated")).toEqual([
      { type: "extension-deactivated", extensionId: "flaky.kit", name: "Flaky Kit", reason: "failed three times in a row — failure" },
    ]);
  });

  it("does not count an expected error toward the three failures", async () => {
    const { registry: r, events } = registry();
    await r.activate({
      id: "picky.kit",
      name: "Picky Kit",
      activate: (ctx) => {
        ctx.registerCommand("check", (input) => {
          if (input === "bad") throw new HostCommandError("not a folder");
          if (input === "crash") throw new Error("crash");
          return "ok";
        });
      },
    });
    for (let index = 0; index < 4; index += 1) {
      await expect(r.invoke("picky.kit", "check", "bad")).rejects.toThrow("not a folder");
    }
    expect(r.isActive("picky.kit")).toBe(true);
    // Expected errors neither reset the counter: two crashes around them still add up.
    await expect(r.invoke("picky.kit", "check", "crash")).rejects.toThrow("crash");
    await expect(r.invoke("picky.kit", "check", "bad")).rejects.toThrow("not a folder");
    await expect(r.invoke("picky.kit", "check", "crash")).rejects.toThrow("crash");
    expect(r.isActive("picky.kit")).toBe(true);
    await expect(r.invoke("picky.kit", "check", "crash")).rejects.toThrow("crash");
    expect(r.isActive("picky.kit")).toBe(false);
    expect(events.filter((event) => event.type === "extension-deactivated")).toHaveLength(1);
  });

  it("announces a failure the extension reports itself, once, and keeps an activation failure quiet", async () => {
    const { registry: r, events } = registry();
    let reportFailure: ((reason: string) => void) | undefined;
    await r.activate({
      id: "worker.kit",
      name: "Worker Kit",
      activate: (ctx) => { reportFailure = ctx.fail; },
    });

    reportFailure?.("worker exited with code 1");
    reportFailure?.("worker exited with code 1");
    await Promise.resolve();

    expect(r.isActive("worker.kit")).toBe(false);
    expect(events.filter((event) => event.type === "extension-deactivated")).toEqual([
      { type: "extension-deactivated", extensionId: "worker.kit", name: "Worker Kit", reason: "worker exited with code 1" },
    ]);

    // A package that fails while activating never ran, so nothing is announced.
    events.length = 0;
    await r.activate({ id: "broken.kit", name: "Broken Kit", activate: (ctx) => { ctx.fail("heap out of memory"); } });
    expect(events.filter((event) => event.type === "extension-deactivated")).toEqual([]);
    expect(r.summaries().find((entry) => entry.id === "broken.kit")?.error).toBe("heap out of memory");
  });

  it("counts failures per command so a successful command does not reset a sibling's counter", async () => {
    const { registry: r, events } = registry();
    await r.activate({
      id: "mixed.kit",
      name: "Mixed Kit",
      activate: (ctx) => {
        ctx.registerCommand("reliable", () => "ok");
        ctx.registerCommand("fragile", () => { throw new Error("boom"); });
      },
    });

    // Two failures of `fragile`
    await expect(r.invoke("mixed.kit", "fragile")).rejects.toThrow("boom");
    await expect(r.invoke("mixed.kit", "fragile")).rejects.toThrow("boom");
    // A successful call on the sibling must not reset `fragile`'s counter.
    await expect(r.invoke("mixed.kit", "reliable")).resolves.toBe("ok");
    expect(r.isActive("mixed.kit")).toBe(true);
    // Third failure of `fragile` — must deactivate now.
    await expect(r.invoke("mixed.kit", "fragile")).rejects.toThrow("boom");
    expect(r.isActive("mixed.kit")).toBe(false);
    expect(events.filter((e) => e.type === "extension-deactivated")).toHaveLength(1);
  });
});
