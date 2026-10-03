import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostExtensionSeam, type ExtensionServicesPort } from "./host-ports.js";
import { SessionLocks } from "./session-locks.js";
import { importDependency, loadDependencyModule } from "./dependency-loader.js";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";

describe("loadDependencyModule", () => {
  it("hands a CommonJS module's exports and an ES module's namespace to the kit", async () => {
    const exports = { spawn: () => undefined };
    expect(await loadDependencyModule("node-pty", async () => ({ default: exports }))).toBe(exports);
    const namespace: { default?: unknown; named: number } = { named: 1 };
    expect(await loadDependencyModule("esm-only", async () => namespace)).toBe(namespace);
  });

  it("retains named exports beside a default export when a kit requests the namespace", async () => {
    const namespace = { default: () => undefined, Client: class {} };
    expect(await loadDependencyModule("driver", async () => namespace, { namespace: true })).toBe(namespace);
    expect(await loadDependencyModule("driver", async () => namespace)).toBe(namespace.default);
    expect(await loadDependencyModule("@scope/package/compat", async () => namespace, { namespace: true })).toBe(namespace);
  });

  it("loads by package name only, never by path", async () => {
    const load = vi.fn(async () => ({}));
    await expect(loadDependencyModule("../secrets.js", load)).rejects.toThrow(/not a package name/);
    await expect(importDependency("/etc/passwd")).rejects.toThrow(/not a package name/);
    await expect(importDependency("@scope/../x")).rejects.toThrow(/not a package name/);
    await expect(importDependency("package/../x")).rejects.toThrow(/not a package name/);
    await expect(importDependency("package//x")).rejects.toThrow(/not a package name/);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("registerRuntimeBackend", () => {
  const seam = () => {
    const changed = vi.fn();
    const port = { registerTurnObserver: () => () => undefined, log: () => undefined, runtimeBackendsChanged: changed } as unknown as ExtensionServicesPort;
    return { seam: createHostExtensionSeam(port), changed };
  };
  const provider = (kind: string) => ({
    kind,
    adapter: { id: kind, capabilities: { skillInvocationDialect: "pi" }, transport: { sendPrompt: async () => ({}) } },
    listThreads: async () => [],
    lookup: async () => undefined,
    open: async () => { throw new Error("unused"); },
    composerCommands: () => [],
  }) as unknown as HostRuntimeBackendProvider;

  it("takes a program's instances as kinds of their own and says when the set changed", () => {
    const { seam: { services, backends }, changed } = seam();
    const stopDefault = services.registerRuntimeBackend(provider("codex"));
    const stopWork = services.registerRuntimeBackend(provider("codex@work"));
    expect([...backends.keys()]).toEqual(["codex", "codex@work"]);
    expect(changed).toHaveBeenCalledTimes(2);
    stopWork();
    stopWork();
    expect([...backends.keys()]).toEqual(["codex"]);
    expect(changed).toHaveBeenCalledTimes(3);
    stopDefault();
  });

  it("refuses Pi's kind, its instances and a kind that is no name", () => {
    const { services } = seam().seam;
    for (const kind of ["pi", "pi@work", "codex@Work", "codex@a@b", "bad kind", "", "@work"]) {
      expect(() => services.registerRuntimeBackend(provider(kind)), kind).toThrow();
    }
  });
});

describe("sessions.open for a session another process holds", () => {
  const timestamp = "2026-09-27T00:00:00.000Z";
  const entry = (id: string, parentId: string | null, role: "user" | "assistant", text: string) =>
    JSON.stringify({ type: "message", id, parentId, timestamp, message: { role, content: [{ type: "text", text }], timestamp: 1 } });
  const session = (dir: string, version: number, finalNewline: boolean) => {
    const path = join(dir, `${timestamp.replace(/[:.]/gu, "-")}_s${version}.jsonl`);
    const text = [JSON.stringify({ type: "session", version, id: `s${version}`, timestamp, cwd: dir }), entry("e1", null, "user", "Hi")].join("\n");
    writeFileSync(path, finalNewline ? `${text}\n` : text);
    return path;
  };
  const seamWith = (locks: SessionLocks) => createHostExtensionSeam({
    registerTurnObserver: () => () => undefined,
    log: () => undefined,
    sessionLocks: locks,
    prepareThread: async () => { throw new Error("unused"); },
  } as unknown as ExtensionServicesPort);

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tau-seam-sessions-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reads a file Pi would repair without the repair, and writes nothing through it", async () => {
    const path = session(dir, 2, false);
    const before = readFileSync(path, "utf8");
    const other = new SessionLocks({ dataFolder: "/data/window" });
    await other.acquire(path);
    const { services } = seamWith(new SessionLocks());

    const file = services.sessions.open(path);
    expect(file.sessionId).toBe("s2");
    expect(file.entries()).toHaveLength(1);
    expect(() => file.appendEntry("note", {})).toThrow(/open in another Tau host \(pid \d+, data folder \/data\/window\); nothing was written/u);
    expect(() => file.branch("e1")).toThrow(/nothing was written/u);
    await expect(services.sessions.prepare(file)).rejects.toThrow(/read-only here/u);
    expect(readFileSync(path, "utf8")).toBe(before);
    other.releaseAll();
  });

  it("refuses each write while another process holds the session, and writes once it is let go", async () => {
    const path = session(dir, 3, true);
    const other = new SessionLocks();
    await other.acquire(path);
    const { services } = seamWith(new SessionLocks());
    const file = services.sessions.open(path);

    expect(() => file.appendInfo("renamed")).toThrow(/nothing was written/u);
    other.releaseAll();
    file.appendEntry("note", { ok: true });
    expect(readFileSync(path, "utf8")).toContain("\"customType\":\"note\"");
  });

  it("writes through a session this host holds", async () => {
    const path = session(dir, 3, true);
    const own = new SessionLocks();
    await own.acquire(path);
    const file = seamWith(own).services.sessions.open(path);
    file.appendEntry("note", { ok: true });
    expect(readFileSync(path, "utf8")).toContain("\"customType\":\"note\"");
    own.releaseAll();
  });
});

describe("runtime tool service", () => {
  it("is optional and delegates maintenance to the host's updater", async () => {
    const base = { registerTurnObserver: () => () => undefined, log: () => undefined } as unknown as ExtensionServicesPort;
    expect(createHostExtensionSeam(base).services.runtimeTools).toBeUndefined();
    const runtimeTools = vi.fn(async () => ({ tools: [], log: [] }));
    const seam = createHostExtensionSeam({ ...base, runtimeTools });
    await seam.services.runtimeTools!("update", { kind: "codex" });
    expect(runtimeTools).toHaveBeenCalledExactlyOnceWith("update", { kind: "codex" });
  });
});
