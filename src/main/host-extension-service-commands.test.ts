import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  WORKER_SERVICE_COMMANDS as C, createWorkerServiceCaller,
  type WorkerServiceArgs, type WorkerServiceDispatch, type WorkerServiceName, type WorkerServiceResult,
} from "./host-extension-service-commands.js";
import type { WorkerHostServices, WorkerThreadSnapshot } from "./host-extension-worker-protocol.js";

const valid = {
  cwd: [], openWorkspace: ["/repo"], knownWorkspacePath: ["/repo"], workspaceRef: ["/repo"], admitWorkspace: ["/repo"],
  projectName: ["/repo"], settings: ["/repo"], priceUsage: [[]], rememberProjectName: ["/repo", "Project"],
  pickDirectory: [{ buttonLabel: "", message: "Pick", createDirectory: true }], runtimeOwner: [], thread: ["s1"], transcript: ["s1"],
  setThreadTitle: ["s1", "", "renamed"], noteSubprocess: [], findCommand: ["node"], skills: ["/repo"], refreshExtensionPackages: [],
  describeProjects: [["name", "root"]], "sessions.list": [], "sessions.read": ["/session.jsonl"],
  "sessions.start": [{ cwd: "/repo", prompt: "", attachments: [], model: { provider: "acme", id: "model" }, parent: { threadId: "p1", details: { nested: [1] } }, tools: ["read"], backend: "custom", thinkingLevel: "high", mode: "default", title: "Child" }],
  "sessions.import": [{ cwd: "/repo", jsonl: "{}", origin: { hostId: "h1", threadId: "s1", details: { imported: true } }, title: "Imported" }],
  "sessions.remove": ["s1"], "sessions.restore": ["s1"], "sessions.trash": [], "sessions.purge": ["s1"], "sessions.exclusive": [],
  "clients.count": [], "clients.devices": [], "clients.observe": [["attached", "devicesChanged"]],
  "network.state": [], "network.holdProxy": [], "network.keepProxy": [false],
  "network.publishEndpoints": [[{ url: "https://tau.local", label: "Tau", reachability: "network", kind: "mdns", interface: "en0", ipv6: false, trustedCertificate: true }]],
  observeConfigChanges: [["changed"]], registerThreadLifecycle: [["beforeActivate", "afterFork"]], registerTurnObserver: [["ended", "toolEnded"]],
  setPendingWork: ["s1", 0], pinTranscriptEntries: [{ s1: ["entry"] }], offering: ["acme/source"], hostExtension: ["acme.target", "read", { value: 1 }],
} satisfies { [Name in WorkerServiceName]: WorkerServiceArgs<typeof C[Name]> };

const malformed: Record<WorkerServiceName, readonly unknown[]> = {
  cwd: ["extra"], openWorkspace: [null], knownWorkspacePath: [1], workspaceRef: [{}], admitWorkspace: [[]],
  projectName: [undefined], settings: [1], priceUsage: [[{ inputTokens: 1 }]], rememberProjectName: ["/repo", false],
  pickDirectory: [{ createDirectory: "yes" }], runtimeOwner: [true], thread: [1], transcript: [false], setThreadTitle: ["s1", "Title", "other"],
  noteSubprocess: [1], findCommand: [], skills: [null], refreshExtensionPackages: [1], describeProjects: [["unknown"]],
  "sessions.list": [1], "sessions.read": [false], "sessions.start": [{ cwd: "/repo", prompt: 1 }], "sessions.import": [{ cwd: "/repo", jsonl: "{}", origin: {} }],
  "sessions.remove": [], "sessions.restore": [null], "sessions.trash": [1], "sessions.purge": [false], "sessions.exclusive": [1],
  "clients.count": [1], "clients.devices": [1], "clients.observe": [["unknown"]], "network.state": [1], "network.holdProxy": [1], "network.keepProxy": [1],
  "network.publishEndpoints": [[{ url: "http://tau", label: "Tau", reachability: "other" }]], observeConfigChanges: [["other"]],
  registerThreadLifecycle: [["unknown"]], registerTurnObserver: [["pending"]], setPendingWork: ["s1", "1"], pinTranscriptEntries: [{ s1: [1] }],
  offering: [false], hostExtension: ["acme.target", false],
};

type ServicePaths<T> = { [Key in keyof T & string]: T[Key] extends (...args: never[]) => unknown ? Key : T[Key] extends object ? `${Key}.${ServicePaths<T[Key]>}` : never }[keyof T & string];

describe("worker service declarations", () => {
  it("covers every RPC member of the worker facade and both context calls", () => {
    expectTypeOf<Exclude<ServicePaths<WorkerHostServices>, "log">>().toEqualTypeOf<Exclude<WorkerServiceName, "offering" | "hostExtension">>();
    expect(Object.keys(C).sort()).toEqual(Object.keys(valid).sort());
    for (const [name, definition] of Object.entries(C)) expect(definition.name).toBe(name);
  });

  for (const definition of Object.values(C)) {
    it(`decodes ${definition.name} before invoking its implementation`, async () => {
      const handler = vi.fn();
      const bound = definition.implement(handler);
      await bound.dispatch(valid[definition.name], 7);
      expect(handler).toHaveBeenCalledWith(definition.decode(valid[definition.name]), 7);
      handler.mockClear();
      await expect(bound.dispatch(malformed[definition.name], 8)).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
      for (const envelope of [null, {}, "args"]) {
        expect(() => Reflect.apply(definition.decode, undefined, [envelope])).toThrow();
      }
      expect(() => definition.decode([...valid[definition.name], "extra", "extra", "extra"])).toThrow();
    });
  }

  it("allows omitted optional arguments and arbitrary cross-extension payloads", () => {
    for (const definition of [C.settings, C.thread, C.transcript, C.pickDirectory]) expect(definition.decode([])).toEqual([undefined]);
    expect(C.hostExtension.decode(["acme", "read"])).toEqual(["acme", "read", undefined]);
    expect(C.hostExtension.decode(["acme", "read", [1, null]])).toEqual(["acme", "read", [1, null]]);
  });

  it.each([
    ["sessions.start", { cwd: "/repo", prompt: "go", model: { provider: 1, id: "x" } }],
    ["sessions.start", { cwd: "/repo", prompt: "go", tools: [1] }],
    ["sessions.start", { cwd: "/repo", prompt: "go", attachments: [{}] }],
    ["sessions.start", { cwd: "/repo", prompt: "go", skillDraft: { source: "other" } }],
    ["sessions.start", { cwd: "/repo", prompt: "go", parent: { threadId: "p1", details: [] } }],
    ["sessions.start", { cwd: "/repo", prompt: "go", beforePrompt: true }],
    ["sessions.import", { cwd: "/repo", jsonl: "{}", origin: { hostId: "h1", threadId: "s1", details: [] } }],
  ] as const)("rejects malformed nested input to %s", (name, input) => {
    expect(() => C[name].decode([input])).toThrow();
  });

  it.each([NaN, Infinity, -Infinity, "2", null])("rejects invalid pending count %s", (count) => {
    expect(() => C.setPendingWork.decode(["s1", count])).toThrow();
  });

  it("preserves finite pending counts, including clearing nonpositive counts", () => {
    for (const count of [-1, 0, 1.5, 2]) expect(C.setPendingWork.decode(["s1", count])).toEqual(["s1", count]);
  });

  it("preserves endpoint variants and string-keyed pins", () => {
    for (const kind of ["loopback", "lan", "mdns", "tailscale", "magicdns"]) {
      expect(C["network.publishEndpoints"].decode([[{ url: "http://tau", label: "", reachability: "network", kind }]])[0][0]?.kind).toBe(kind);
    }
    const pins = JSON.parse('{"__proto__":["entry"],"constructor":["other"]}');
    expect(C.pinTranscriptEntries.decode([pins])[0]).toEqual(pins);
  });

  it("derives caller results, handler tuples and dispatch identity from declarations", async () => {
    const run = C.cwd.implement(() => "/repo");
    const transport = vi.fn(async (_path: string, args: readonly unknown[]) => run.dispatch(args, 3));
    const call = createWorkerServiceCaller(transport);
    const result = call(C.cwd);
    expectTypeOf(result).toEqualTypeOf<Promise<string>>();
    expectTypeOf<WorkerServiceResult<typeof C.thread>>().toEqualTypeOf<WorkerThreadSnapshot | undefined>();
    expectTypeOf<WorkerServiceResult<typeof C.pickDirectory>>().toEqualTypeOf<string | undefined>();
    await expect(result).resolves.toBe("/repo");
    expect(transport).toHaveBeenCalledWith("cwd", []);
    expectTypeOf<WorkerServiceResult<typeof C["network.holdProxy"]>>().toEqualTypeOf<number>();
    // These assertions are checked by the focused electron typecheck.
    if (false) {
      // @ts-expect-error Incorrect argument type cannot cross the caller.
      call(C.openWorkspace, 1);
      // @ts-expect-error Result type comes from the declaration.
      const wrong: Promise<number> = call(C.cwd);
      // @ts-expect-error Implementations cannot choose their own result type.
      C.cwd.implement(() => 42);
      // @ts-expect-error Decoded arguments are typed before reaching a handler.
      C.setPendingWork.implement(([sessionId]) => sessionId.toFixed());
      // @ts-expect-error Dispatch entries must implement the matching declaration.
      const swapped: WorkerServiceDispatch["cwd"] = C["clients.count"].implement(() => 1);
      void wrong; void swapped;
    }
  });
});
