import { expect, it } from "vitest";
import { ownedProcessTree } from "./test-support/owned-process-tree.js";
import { stopThread } from "./thread-stop.js";

it.skipIf(process.platform === "win32")("Stop ends a shell command and every descendant after pausing its goal", async () => {
  const tree = await ownedProcessTree();
  let paused = false;
  try {
    await stopThread({
      current: () => ({ objective: "Finish the tests", status: "active", actions: { pause: true, resume: true }, updatedAt: 1 }),
      pause: async () => { paused = true; expect(tree.alive()).toEqual(tree.pids); },
      set: async () => undefined,
      resume: async () => undefined,
      clear: async () => undefined,
    }, {
      dropWakes: () => 0,
      holdQueue: () => undefined,
      observers: async () => ({ stopped: [], continues: [] }),
      abort: async () => { expect(paused).toBe(true); await tree.stop(); },
      notice: async () => undefined,
      toast: () => undefined,
      log: () => undefined,
    });
    await expect.poll(tree.alive, { timeout: 20_000 }).toEqual([]);
  } finally { await tree.close(); }
});
