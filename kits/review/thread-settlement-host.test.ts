import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HostTurnObserver } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createThreadRailHostExtension } from "../thread-rail/host.js";
import type { RailState } from "../thread-rail/protocol.js";
import { createReviewHostExtension } from "./host.js";

let dispose: (() => Promise<void>) | undefined;
let directory: string | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it("settles a CLI-merged linked PR after turn-end with real Review and Thread Rail kits", async () => {
  directory = await mkdtemp(join(tmpdir(), "tau-merge-settlement-"));
  const detail = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/gh-pr-view-discussed.json"), "utf8"));
  let merged = false;
  let integrated = true;
  const observers: HostTurnObserver[] = [];
  const registry = await activateHostKit({
    id: "tau.workspace", name: "Workspace probe", activate(context) {
      context.registerCommand("thread-work-integrated", () => ({ integrated }), { callers: ["tau.thread-rail"] });
    },
  }, {
    stateDir: directory,
    sessions: { list: async () => [{ sessionId: "thread", cwd: "/checkout", path: "/session" }], trash: async () => [] } as never,
    findCommand: () => "/fake/gh",
    noteSubprocess: () => undefined,
    thread: () => undefined,
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    registerThreadLifecycle: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    mcp: { registerTools: () => () => undefined, registerInstructions: () => () => undefined } as never,
  });
  dispose = () => registry.dispose();
  await registry.activate(createReviewHostExtension({
    run: async (_command, args) => args[0] === "pr" && args[1] === "view"
      ? JSON.stringify({ ...detail, state: merged ? "MERGED" : "OPEN" }) : "{}",
  }));
  await registry.activate(createThreadRailHostExtension({ sweepMs: 1_000_000_000, modifiedAt: async () => Date.now() }));
  const state = async () => await registry.invoke("tau.thread-rail", "state") as RailState;
  for (const observer of observers) observer.accepted?.("thread", "turn", { deferBefore: false });
  await registry.invoke("tau.review", "link-pr", { threadId: "thread", reference: "https://github.com/acme/tau/pull/7" });
  merged = true;
  await Promise.all(observers.map((observer) => observer.ended?.("thread", "turn", {} as never)));
  await vi.waitFor(async () => expect((await state()).threads.thread?.settledBy).toBe("pr-merged"));

  // A later turn on the same merged PR must remain active until its new work lands.
  integrated = false;
  for (const observer of observers) observer.accepted?.("thread", "next", { deferBefore: false });
  await Promise.all(observers.map((observer) => observer.ended?.("thread", "next", {} as never)));
  await registry.invoke("tau.thread-rail", "sweep");
  expect((await state()).threads.thread?.settledAt).toBeUndefined();

  // Linking the follow-up's merged request settles it without another turn or timer.
  integrated = true;
  await registry.invoke("tau.review", "link-pr", { threadId: "thread", reference: "https://github.com/acme/tau/pull/8" });
  await vi.waitFor(async () => expect((await state()).threads.thread?.settledBy).toBe("pr-merged"));
});
