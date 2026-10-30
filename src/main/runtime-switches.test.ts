import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { UiMessage } from "../shared/contracts.js";
import type { ThreadRuntimeBackend, ThreadBackendPromptInput } from "./runtime-types.js";
import { RuntimeSwitches } from "./runtime-switches.js";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const history: UiMessage[] = [{ id: "old-user", role: "user", text: "Keep my context", timestamp: 1 }];
it("retains visible history and sends context once, including across a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-switch-history-")); folders.push(directory);
  const path = join(directory, "history.json"); const store = new RuntimeSwitches(path);
  await store.set("same-id", { kind: "second", cwd: directory, history, offset: 1, contextPending: true });
  const prompt = vi.fn(async (_input: ThreadBackendPromptInput) => ({}));
  const backend = { kind: "second", threadId: "same-id", cwd: directory, capabilities: {}, prompt, transcript: async () => [{ id: "old-target", role: "user", text: "old segment" }, { id: "new-target", role: "assistant", text: "new segment" }], state: () => ({ hasMessages: true }), persist: vi.fn() } as unknown as ThreadRuntimeBackend;
  const wrapped = new RuntimeSwitches(path).wrap(backend);
  expect((await wrapped.transcript()).map(message => message.id)).toEqual(["old-user", "new-target"]);
  await wrapped.prompt({ text: "next", delivery: "prompt" });
  expect(prompt).toHaveBeenLastCalledWith(expect.objectContaining({ text: "next", continuationContext: "user: Keep my context" }));
  const resumed = new RuntimeSwitches(path).wrap(backend);
  await resumed.prompt({ text: "again", delivery: "prompt" });
  expect(prompt.mock.calls.at(-1)?.[0]).not.toHaveProperty("continuationContext");
});
it("keeps the context pending if the target refuses a prompt", async () => {
  const store = new RuntimeSwitches(); await store.set("same-id", { kind: "second", cwd: "/repo", history, offset: 0, contextPending: true });
  const backend = { kind: "second", threadId: "same-id", capabilities: {}, prompt: async () => { throw new Error("offline"); } } as unknown as ThreadRuntimeBackend;
  await expect(store.wrap(backend).prompt({ text: "next", delivery: "prompt" })).rejects.toThrow("offline");
  expect(store.get("same-id")?.contextPending).toBe(true);
});
