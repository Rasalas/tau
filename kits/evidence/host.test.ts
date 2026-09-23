import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostExtension, HostMcpToolProvider, HostThreadLifecycle, HostTurnObserver, RuntimeExtensionContribution, TurnAttachmentProvider } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createEvidenceHostExtension } from "./host.js";
import { EVIDENCE_EXTENSION_ID, type EncodedFrame, type EvidenceThread } from "./protocol.js";

let stateDir: string;
beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), "tau-evidence-host-")); });
afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

/** Preview Kit as far as Evidence reads it: a page whose name is its content. */
function fakePreview(page: { name: string; asked: number }): HostExtension {
  return {
    id: "tau.preview",
    name: "Preview",
    activate: (context) => {
      context.registerCommand("evidence-frame", () => ({ asked: page.asked += 1, data: Buffer.from(page.name).toString("base64"), width: 960, height: 600, url: "http://localhost:5173/", title: page.name, visible: true }), { callers: [EVIDENCE_EXTENSION_ID] });
    },
  };
}

const shades = new Map<string, number>();
function encode(input: { data: string }): EncodedFrame {
  const name = Buffer.from(input.data, "base64").toString();
  if (!shades.has(name)) shades.set(name, (shades.size * 40) % 240);
  return {
    frame: Buffer.from(`jpeg:${name}`).toString("base64"), width: 960, height: 600,
    thumb: Buffer.from(`thumb:${name}`).toString("base64"),
    luma: Buffer.from(Array.from({ length: 64 }, () => shades.get(name)!)).toString("base64"), lumaWidth: 64, lumaHeight: 1,
  };
}

async function activate() {
  const page = { name: "page-a", asked: 0 };
  const observers: HostTurnObserver[] = [];
  const lifecycles: HostThreadLifecycle[] = [];
  const runtime: RuntimeExtensionContribution[] = [];
  const mcp: HostMcpToolProvider[] = [];
  const events: PublishedKitEvent[] = [];
  let provider: TurnAttachmentProvider | undefined;
  const announced: string[] = [];
  const kit = await activateHostKit(createEvidenceHostExtension(), {
    stateDir,
    thread: ((sessionId?: string) => ({ sessionId: sessionId ?? "thread", cwd: "/project" })) as never,
    settings: (async () => ({ options: {}, values: {} })) as never,
    callClient: (async (_id: string, command: string, input: unknown) => {
      if (command !== "encode") throw new Error(command);
      return encode(input as { data: string });
    }) as never,
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    registerThreadLifecycle: (lifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
    registerRuntimeExtension: (name, factory) => { runtime.push({ name, factory }); return () => undefined; },
    mcp: { registerTools: (tools) => { mcp.push(tools); return () => undefined; }, gate: () => () => undefined, connect: async () => undefined },
    turnAttachments: {
      provide: (next) => { provider = next; return () => { provider = undefined; }; },
      changed: (threadId) => { announced.push(threadId); },
      list: async () => [],
      read: async () => undefined,
      observe: () => () => undefined,
    },
  }, (event) => events.push(event));
  await kit.activate(fakePreview(page));
  const invoke = (command: string, input?: unknown) => kit.invoke(EVIDENCE_EXTENSION_ID, command, input);
  /** Waits, by turns of the event loop, until the kit's disk work shows what the test expects. */
  const until = async (check: (thread: EvidenceThread) => boolean, threadId = "thread") => {
    for (let round = 0; round < 2_000; round += 1) {
      const thread = await invoke("list", { threadId }) as EvidenceThread;
      if (check(thread)) return thread;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("The kit never got there.");
  };
  const frames = (thread: EvidenceThread) => thread.turns.flatMap((turn) => turn.frames);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { page, observers, lifecycles, runtime, mcp, events, provider: () => provider, announced, invoke, settle, until, frames };
}

describe("Evidence host extension", () => {
  it("pictures a turn that changed the Preview, lists it, and offers it to other kits as turn attachments", async () => {
    const { page, observers, invoke, settle, until, frames, provider, announced, events } = await activate();
    const [observer] = observers;
    observer!.accepted?.("thread", "t1", { deferBefore: false });
    await observer!.prepare?.("thread", "t1");
    while (page.asked === 0) await settle();
    page.name = "page-b";
    observer!.toolEnded?.("thread", { id: "c1", name: "preview_click", args: { text: "Save" }, status: "done", startedAt: 1 }, "/project");
    await until((next) => frames(next).length === 2);
    await observer!.ended?.("thread", "t1", "completed");

    const thread = await until((next) => next.turns[0]?.endedAt !== undefined);
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0]!.frames.map((frame) => frame.caption)).toEqual(["When the turn started", "Clicked “Save”"]);
    const [first] = thread.turns[0]!.frames;
    expect(await invoke("image", { threadId: "thread", id: first!.id, thumb: true })).toBe(`data:image/jpeg;base64,${Buffer.from("thumb:page-a").toString("base64")}`);

    const attachments = await provider()!.list("thread");
    expect(attachments.map((entry) => [entry.caption, entry.mediaType, entry.turnId])).toEqual([
      ["When the turn started", "image/jpeg", "t1"],
      ["Clicked “Save”", "image/jpeg", "t1"],
    ]);
    expect(await provider()!.read("thread", first!.id)).toEqual({ mediaType: "image/jpeg", data: Buffer.from("jpeg:page-a").toString("base64") });
    expect(announced).toContain("thread");
    expect(events.some((event) => event.name === "changed")).toBe(true);
  });

  it("gives Pi and the other runtimes attach_evidence, bound to the calling thread", async () => {
    const { runtime, mcp, invoke } = await activate();
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
    await runtime[0]!.factory({ registerTool: (tool: never) => tools.push(tool) } as never, { sessionId: "pi-thread", cwd: "/project" });
    const [piTool] = tools;
    expect(piTool!.name).toBe("attach_evidence");
    const answer = await piTool!.execute("call", { caption: "after: blue" }, undefined, undefined, { sessionManager: { getSessionId: () => "pi-thread" } });
    expect(answer.content[0]!.text).toBe("Attached “after: blue” from the Preview (960×600).");
    expect((await invoke("list", { threadId: "pi-thread" }) as EvidenceThread).turns[0]!.frames[0]!.caption).toBe("after: blue");

    const [mcpTool] = mcp[0]!({ sessionId: "codex-thread", cwd: "/project" }) as unknown as typeof tools;
    await mcpTool!.execute("call", { caption: "over MCP" }, undefined, undefined, undefined);
    expect((await invoke("list", { threadId: "codex-thread" }) as EvidenceThread).turns).toHaveLength(1);
  });

  it("forgets a thread's pictures when the thread is deleted for good, and pauses on request", async () => {
    const { runtime, lifecycles, invoke, events } = await activate();
    const tools: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    await runtime[0]!.factory({ registerTool: (tool: never) => tools.push(tool) } as never, { sessionId: "gone", cwd: "/project" });
    await tools[0]!.execute("call", { caption: "x" }, undefined, undefined, undefined);
    await lifecycles[0]!.threadDeleted?.("gone", "/project");
    expect(await invoke("list", { threadId: "gone" })).toEqual({ threadId: "gone", turns: [] });

    await invoke("pause", { threadId: "gone", reason: "Signing in" });
    expect(await invoke("paused")).toEqual({ gone: "Signing in" });
    expect(events.filter((event) => event.name === "paused").at(-1)?.payload).toEqual({ paused: { gone: "Signing in" } });
    await invoke("resume", { threadId: "gone" });
    expect(await invoke("paused")).toEqual({});
  });
});
