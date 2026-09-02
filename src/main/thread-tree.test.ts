import { describe, expect, it } from "vitest";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { PiThreadRuntimeBackend } from "./thread-runtime-backend.js";

const message = (id: string, parentId: string | null, role: "user" | "assistant", content: unknown, timestamp = "2026-09-02T10:00:00Z") =>
  ({ type: "message", id, parentId, timestamp, message: { role, content } });

describe("Pi thread tree", () => {
  it("flattens the session tree, marks the current branch and hides structural entries", async () => {
    const entries = {
      u1: message("u1", null, "user", "Plan the feature"),
      a1: message("a1", "u1", "assistant", [{ type: "text", text: "Sure.\nDetails follow" }]),
      m1: { type: "model_change", id: "m1", parentId: "a1", timestamp: "2026-09-02T10:01:00Z" },
      u2: message("u2", "m1", "user", "Take the first option"),
      u2b: message("u2b", "a1", "user", [{ type: "image" }]),
      s1: { type: "branch_summary", id: "s1", parentId: "u2b", timestamp: "2026-09-02T10:02:00Z", summary: "Abandoned the second path" },
      a3: message("a3", "u2", "assistant", [{ type: "toolCall", name: "read" }]),
    };
    const tree = [{
      entry: entries.u1, children: [{
        entry: entries.a1, label: "start", children: [
          { entry: entries.m1, children: [{ entry: entries.u2, children: [{ entry: entries.a3, children: [] }] }] },
          { entry: entries.u2b, children: [{ entry: entries.s1, children: [] }] },
        ],
      }],
    }];
    const navigations: unknown[] = [];
    const session = {
      sessionId: "s1",
      sessionManager: {
        getTree: () => tree,
        getBranch: () => [entries.u1, entries.a1, entries.m1, entries.u2, entries.a3],
        getLeafId: () => "a3",
      },
      navigateTree: async (targetId: string, options: unknown) => { navigations.push([targetId, options]); return { cancelled: false, editorText: "Take the first option" }; },
    };
    const backend = new PiThreadRuntimeBackend({ session, cwd: "/repo" } as never, PI_AGENT_RUNTIME_ADAPTER, { mapMessages: () => [], index: async () => ({}) as never });
    const snapshot = backend.tree();
    // The raw leaf is a tool-only assistant entry the tree hides; the thread is "at" the last shown entry of its branch.
    expect(snapshot.leafId).toBe("u2");
    expect(snapshot.nodes.map((node) => [node.id, node.depth, node.kind, node.text, node.onBranch, node.forkable, node.label])).toEqual([
      ["u1", 0, "user", "Plan the feature", true, true, undefined],
      ["a1", 1, "assistant", "Sure.", true, false, "start"],
      // The model change is invisible; its child keeps the depth of the shown ancestor's children.
      ["u2", 2, "user", "Take the first option", true, true, undefined],
      ["u2b", 2, "user", "(image)", false, true, undefined],
      ["s1", 3, "summary", "Abandoned the second path", false, false, undefined],
    ]);
    expect(snapshot.nodes.filter((node) => node.isLeaf).map((node) => node.id)).toEqual(["u2"]);
    expect(backend.leafEntryId()).toBe("a3");
    await expect(backend.navigateTree("u2", { summarize: true })).resolves.toEqual({ cancelled: false, draftText: "Take the first option" });
    expect(navigations).toEqual([["u2", { summarize: true }]]);
  });
});
