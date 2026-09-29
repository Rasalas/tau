import { describe, expect, it } from "vitest";
import type { HostThread } from "tau/host-extension";
import { createCheckoutTurns } from "./checkout-turns.js";

const thread = (sessionId: string, cwd: string, streaming: boolean, name?: string) => ({
  sessionId, cwd, isStreaming: () => streaming, sessionName: () => name,
}) as unknown as HostThread;

describe("turns running in a checkout", () => {
  it("names the threads streaming in the same checkout, the asking one included", async () => {
    const threads = new Map([
      ["a", thread("a", "/repo", true, "Fix the header")],
      ["b", thread("b", "/repo/sub", true)],
      ["c", thread("c", "/other", true, "Elsewhere")],
      ["d", thread("d", "/repo", false, "Idle")],
    ]);
    const turns = createCheckoutTurns({ thread: (id?: string) => (id ? threads.get(id) : undefined) }, async (cwd) => (cwd.startsWith("/repo") ? "repo" : cwd));
    for (const id of ["b", "c", "d"]) turns.observer.accepted?.(id, "turn", { deferBefore: false });
    turns.observer.toolEnded?.("gone", { id: "t" } as never, "/repo");

    expect(await turns.running("/repo")).toEqual([{ sessionId: "b", title: "Another thread" }]);
    expect(await turns.running("/repo", "b")).toEqual([{ sessionId: "b", title: "This thread" }]);
    expect(await turns.running("/repo", "a")).toEqual([
      { sessionId: "b", title: "Another thread" },
      { sessionId: "a", title: "Fix the header" },
    ]);
    expect(await turns.running("/other")).toEqual([{ sessionId: "c", title: "Elsewhere" }]);
  });
});
