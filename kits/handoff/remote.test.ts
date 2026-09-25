import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtension, HostExtensionServices, HostMachine, HostMachineServices, HostReadiness, HostThread, UiMessage } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import type { RemoteThreadLink } from "../remote-work/protocol.js";
import { createHandoffHostExtension } from "./host.js";
import {
  HANDOFF_EXTENSION_ID,
  LINEAGE_EVENT,
  REMOTE_MERGE_BACK_COMMAND,
  TARGETS_EVENT,
  type ContinueOnResult,
  type ContinueTarget,
  type LineageState,
  type PrepareMergeBackResult,
  type RemoteMergeBackResult,
} from "./protocol.js";

const LUNA = { provider: "openai-codex", id: "gpt-5.6-luna" };

const message = (id: string, role: "user" | "assistant", text: string): UiMessage => ({ id, role, text, timestamp: 1 });

function thread(sessionId: string, messages: UiMessage[], overrides: Partial<HostThread> = {}): HostThread {
  return {
    sessionId,
    cwd: "/project",
    backendKind: "pi",
    sessionFile: undefined,
    model: LUNA,
    isStreaming: () => false,
    sessionName: () => `Thread ${sessionId}`,
    transcript: async () => messages,
    ...overrides,
  } as unknown as HostThread;
}

function readiness(runtimes: HostReadiness["runtimes"]): HostReadiness {
  return { checkedAt: 0, runtimes, git: { version: "2.45.0", mergeTree: true }, disk: { path: "/", free: 5e10 }, display: { kind: "none" } };
}

type Registry = Awaited<ReturnType<typeof activateHostKit>>;

/**
 * Remote Work Kit's thread service as this kit reaches it: one link, whose
 * result and settlement the test decides.
 */
function fakeRemoteWork() {
  const starts: unknown[] = [];
  let link: RemoteThreadLink | undefined;
  const settle = vi.fn(async (how: "apply" | "discard"): Promise<RemoteThreadLink> => {
    link = { ...link!, status: "settled", settled: { how: how === "apply" ? "applied" : "discarded", at: 3, detail: "Merged tau/rex/parser." } };
    return link;
  });
  const extension: HostExtension = {
    id: "tau.remote-work",
    name: "Remote Work",
    activate(context) {
      const callers = { callers: [HANDOFF_EXTENSION_ID] };
      context.registerCommand("thread-start", (input) => {
        starts.push(input);
        link = { id: "l1", machine: "rex-id", machineName: "rex", cwd: "/project", root: "/project", status: "sending", createdAt: 1, updatedAt: 1, parentThreadId: (input as { parentThreadId: string }).parentThreadId };
        return link;
      }, callers);
      context.registerCommand("thread", () => link, { access: "read", ...callers });
      context.registerCommand("thread-result", () => {
        link = { ...link!, status: "idle", thread: "rex-thread", result: { state: "branch", branch: "tau/rex/parser", tip: "c".repeat(40), commits: 1, files: 2, paths: ["src/parser.ts", "notes.md"], fetchedAt: 2 } };
        return link;
      }, callers);
      context.registerCommand("thread-settle", (input) => settle((input as { how: "apply" | "discard" }).how), callers);
    },
  };
  return { extension, starts, settle, link: () => link, setLink: (next: RemoteThreadLink) => { link = next; } };
}

describe("Handoff Kit: continue on another machine and bring it back", () => {
  let stateDir: string;
  let events: PublishedKitEvent[];
  let threads: Map<string, HostThread>;
  let rexThreads: Map<string, HostThread>;
  let complete: ReturnType<typeof vi.fn>;
  let rexComplete: ReturnType<typeof vi.fn>;
  let machineList: HostMachine[];
  let rexReadiness: HostReadiness;
  let calls: Array<{ command: string; input: unknown }>;
  const registries: Registry[] = [];

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "tau-handoff-remote-"));
    events = [];
    threads = new Map();
    rexThreads = new Map();
    complete = vi.fn(async () => "## Goal\nKeep the parser fast.");
    rexComplete = vi.fn(async () => "## What was done\nCached the tokens.");
    machineList = [{ id: "rex-id", name: "rex", status: "connected", hostVersion: "0.6.0" }];
    rexReadiness = readiness([
      { kind: "pi", label: "Pi", state: "ready" },
      { kind: "codex", label: "Codex", state: "sign-in-required" },
    ]);
    calls = [];
  });
  afterEach(async () => {
    for (const registry of registries.splice(0)) await registry.dispose();
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Host A with this kit and a stand-in Remote Work Kit; its machines reach rex's registry with this kit. */
  const hosts = async () => {
    const rex = await activateHostKit(createHandoffHostExtension({ now: () => 5 }), {
      stateDir: join(stateDir, "rex"),
      thread: (id?: string) => (id ? rexThreads.get(id) : undefined),
      complete: rexComplete as HostExtensionServices["complete"],
      completionModels: async () => [{ ...LUNA, name: "Luna" }],
      machines: { self: { id: "rex-id", name: "rex", version: "0.6.0" }, list: () => [], subscribe: () => () => undefined } as unknown as HostMachineServices,
    });
    registries.push(rex);
    const listeners = new Set<(list: readonly HostMachine[]) => void>();
    const machines = {
      self: { id: "mini-id", name: "mini", version: "0.6.0" },
      list: () => machineList,
      subscribe: (listener: (list: readonly HostMachine[]) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      request: vi.fn(async (_machine: string, method: string) => {
        if (method !== "readiness") throw new Error("forbidden");
        return rexReadiness;
      }),
      call: async (_machine: string, extensionId: string, command: string, input?: unknown) => {
        calls.push({ command, input });
        return JSON.parse(JSON.stringify(await rex.invoke(extensionId, command, input, { kind: "workbench-client", connection: "c1", pairedClient: "mini-agents" })));
      },
    } as unknown as HostMachineServices;
    const remoteWork = fakeRemoteWork();
    let clock = 1_000;
    const a = await activateHostKit(createHandoffHostExtension({ now: () => clock++ }), {
      stateDir: join(stateDir, "a"),
      thread: (id?: string) => (id ? threads.get(id) : undefined),
      complete: complete as HostExtensionServices["complete"],
      completionModels: async () => [{ ...LUNA, name: "Luna" }],
      machines,
    }, (event) => events.push(event));
    await a.activate(remoteWork.extension);
    registries.push(a);
    const invoke = <T>(command: string, input?: unknown) => a.invoke(HANDOFF_EXTENSION_ID, command, input) as Promise<T>;
    const lineage = () => events.filter((event) => event.name === LINEAGE_EVENT).at(-1)?.payload as LineageState | undefined;
    const setMachines = (next: HostMachine[]) => {
      machineList = next;
      for (const listener of listeners) listener(next);
    };
    return { a, rex, invoke, remoteWork, lineage, machines, setMachines };
  };

  it("offers the connected machines with Full access and says what runs there", async () => {
    machineList = [
      { id: "rex-id", name: "rex", status: "connected" },
      { id: "ro-id", name: "kiosk", status: "connected", readOnly: true },
      { id: "off-id", name: "attic", status: "offline" },
    ];
    const { invoke } = await hosts();
    const targets = await invoke<ContinueTarget[]>("continue-targets", { refresh: true });
    expect(targets).toEqual([{
      id: "rex-id",
      name: "rex",
      runtimes: [{ kind: "pi", label: "Pi", ready: true }, { kind: "codex", label: "Codex", ready: false, note: "not signed in" }],
    }]);
    expect(events.filter((event) => event.name === TARGETS_EVENT).at(-1)?.payload).toEqual(targets);
  });

  it("sends a Pi thread with its history and the draft, and keeps the thread here usable", async () => {
    threads.set("t1", thread("t1", [message("u1", "user", "Speed up the parser."), message("a1", "assistant", "Cached the tokens.")]));
    const { invoke, remoteWork, lineage } = await hosts();

    const result = await invoke<ContinueOnResult>("continue-on", { threadId: "t1", machine: "rex", prompt: "Now add a benchmark." });
    expect(result).toEqual({ link: "l1", machine: "rex-id", machineName: "rex", native: true });
    // Native: the session goes along and no summary is written.
    expect(remoteWork.starts).toEqual([{
      machine: "rex-id", cwd: "/project", title: "Thread t1", parentThreadId: "t1",
      session: { threadId: "t1" }, prompt: "Now add a benchmark.", model: LUNA,
    }]);
    expect(complete).not.toHaveBeenCalled();
    expect(lineage()?.remotes).toEqual([{ threadId: "t1", link: "l1", machine: "rex-id", machineName: "rex", strategy: "native", createdAt: expect.any(Number) }]);

    // One continuation at a time; once it is over the thread may go again.
    await expect(invoke("continue-on", { threadId: "t1", machine: "rex" })).rejects.toThrow(/continues on rex already/u);
    remoteWork.setLink({ ...remoteWork.link()!, status: "failed", error: "rex went away" });
    await expect(invoke("continue-on", { threadId: "t1", machine: "rex" })).resolves.toMatchObject({ native: true });
  });

  it("starts another runtime's thread there with a handoff block before the draft, and refuses one not ready there", async () => {
    threads.set("t2", thread("t2", [message("u1", "user", "Speed up the parser."), message("a1", "assistant", "Cached the tokens.")], { backendKind: "codex" }));
    const { invoke, remoteWork } = await hosts();

    await expect(invoke("continue-on", { threadId: "t2", machine: "rex", prompt: "Go on." })).rejects.toThrow("Codex is not signed in on rex; sign in there first.");
    rexReadiness = readiness([{ kind: "codex", label: "Codex", state: "ready" }]);
    await invoke("continue-targets", { refresh: true });
    await expect(invoke("continue-on", { threadId: "t2", machine: "rex" })).rejects.toThrow(/Write what rex should do next/u);

    await invoke("continue-on", { threadId: "t2", machine: "rex", prompt: "Go on." });
    const start = remoteWork.starts[0] as { backend: string; prompt: string; session?: unknown };
    expect(start.backend).toBe("codex");
    expect(start.session).toBeUndefined();
    expect(start.prompt).toBe([
      "<handoff_context>",
      "Continued from “Thread t2” (codex · openai-codex/gpt-5.6-luna) on mini. What happened there, as background for the message below:",
      "",
      "## Goal\nKeep the parser fast.",
      "</handoff_context>",
      "",
      "Go on.",
    ].join("\n"));
  });

  it("refuses a machine that is offline or Read only, and a thread without an answer", async () => {
    threads.set("empty", thread("empty", [message("u1", "user", "Hi")]));
    threads.set("t1", thread("t1", [message("u1", "user", "Hi"), message("a1", "assistant", "Hello")]));
    const { invoke, setMachines } = await hosts();
    await expect(invoke("continue-on", { threadId: "empty", machine: "rex" })).rejects.toThrow(/no answer/u);
    setMachines([{ id: "rex-id", name: "rex", status: "offline", detail: "no route" }]);
    await expect(invoke("continue-on", { threadId: "t1", machine: "rex" })).rejects.toThrow("rex is offline: no route.");
    setMachines([{ id: "rex-id", name: "rex", status: "connected", readOnly: true }]);
    await expect(invoke("continue-on", { threadId: "t1", machine: "rex" })).rejects.toThrow(/Read only/u);
  });

  it("brings back the branch and rex's summary of what happened there since it went, then merges on a click", async () => {
    threads.set("t1", thread("t1", [message("u1", "user", "Speed up the parser."), message("a1", "assistant", "Cached the tokens.")]));
    const { invoke, remoteWork, lineage } = await hosts();
    await invoke("continue-on", { threadId: "t1", machine: "rex", prompt: "Add a benchmark." });
    // On rex the imported thread carries A's history, then what happened there.
    rexThreads.set("rex-thread", thread("rex-thread", [
      message("u1", "user", "Speed up the parser."),
      message("a1", "assistant", "Cached the tokens."),
      message("u2", "user", "Add a benchmark."),
      message("a2", "assistant", "Added bench/parser.bench.ts."),
    ], { cwd: "/rex/worktree" }));

    const back = await invoke<PrepareMergeBackResult>("bring-back-remote", { threadId: "t1" });
    expect(calls).toEqual([{ command: REMOTE_MERGE_BACK_COMMAND, input: { threadId: "rex-thread", through: "a1", again: false, files: ["src/parser.ts", "notes.md"] } }]);
    expect(back.parentThreadId).toBe("t1");
    expect(back.context).toBe([
      "<merge_back_context>",
      "Brought back from “Thread rex-thread” (pi · openai-codex/gpt-5.6-luna) on rex, 2 messages since it went there:",
      "",
      "Its work came back as the branch `tau/rex/parser` here (1 commit, 2 files).",
      "",
      "## What was done\nCached the tokens.",
      "</merge_back_context>",
    ].join("\n"));
    // Only what happened on rex goes into the summary, with the branch's files.
    const request = rexComplete.mock.calls[0]![0] as { prompt: string };
    expect(request.prompt).toContain("Files the fork changed: src/parser.ts, notes.md");
    expect(request.prompt).toContain("User: Add a benchmark.");
    expect(request.prompt).not.toContain("Speed up the parser.");

    // The prompt that carries it commits the point; the next bring-back starts after it.
    await invoke("commit-merge-back", { parentThreadId: "t1" });
    expect(lineage()?.remotes?.[0]?.broughtAt).toBeGreaterThan(0);
    // Nothing new there: the branch still comes back, with rex's reason in place of a summary.
    expect((await invoke<PrepareMergeBackResult>("bring-back-remote", { threadId: "t1" })).context).toContain("_No summary came back from rex (Nothing new since it was last brought back.)._");
    expect(calls.at(-1)?.input).toMatchObject({ through: "a2", again: true });

    const merged = await invoke<RemoteThreadLink>("settle-remote", { threadId: "t1", how: "apply" });
    expect(remoteWork.settle).toHaveBeenCalledWith("apply");
    expect(merged.status).toBe("settled");
    expect(lineage()?.remotes).toEqual([]);
  });

  it("summarizes a Pi thread there from its session file when its runtime is not open", async () => {
    const entries = [
      { type: "session", id: "s" },
      { type: "message", id: "e1", message: { role: "user", content: "Speed up the parser." } },
      { type: "message", id: "e2", message: { role: "assistant", content: [{ type: "text", text: "Cached the tokens." }] } },
      { type: "message", id: "e3", message: { role: "user", content: [{ type: "text", text: "Add a benchmark." }] } },
      { type: "message", id: "e4", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "Added the bench." }] } },
      { type: "session_info", id: "e5", name: "Parser speed" },
    ];
    const services = {
      stateDir: join(stateDir, "rex-file"),
      thread: () => undefined,
      complete: rexComplete as HostExtensionServices["complete"],
      completionModels: async () => [],
      sessions: {
        list: async () => [{ sessionId: "rex-thread", path: "/rex/sessions/x.jsonl", cwd: "/rex/worktree" }],
        open: () => ({ path: "/rex/sessions/x.jsonl", sessionId: "rex-thread", cwd: "/rex/worktree", entries: () => entries }),
      } as unknown as HostExtensionServices["sessions"],
    };
    const fromFile = await activateHostKit(createHandoffHostExtension(), services);
    registries.push(fromFile);
    const answer = await fromFile.invoke(HANDOFF_EXTENSION_ID, REMOTE_MERGE_BACK_COMMAND, { threadId: "rex-thread", through: "e2", files: [] }) as RemoteMergeBackResult;
    // No small model there: the excerpt stands in, never the thread's own model.
    expect(rexComplete).not.toHaveBeenCalled();
    expect(answer.header).toBe("Brought back from “Parser speed” (pi) on another machine, 2 messages since it went there:");
    expect(answer.summary).toContain("User: Add a benchmark.\n\nAssistant: Added the bench.");
    expect(answer.through).toBe("e4");
    await expect(fromFile.invoke(HANDOFF_EXTENSION_ID, REMOTE_MERGE_BACK_COMMAND, { threadId: "missing", files: [] })).rejects.toThrow("This machine has no thread missing.");
  });
});
