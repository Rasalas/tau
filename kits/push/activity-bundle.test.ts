import { describe, expect, it } from "vitest";
import { ActivityBundle } from "./activity-bundle.js";

describe("a host's one Live Activity", () => {
  it("lists a question first, keeps a finished thread a quarter hour and stays small enough to seal", () => {
    let now = 1_000_000;
    const bundle = new ActivityBundle(() => now);
    bundle.note("a", "running", "Fix flaky pairing test");
    now += 1000; bundle.note("b", "running", "Add pagination");
    now += 1000; bundle.note("b", "waiting", "Add pagination", "Wants to edit src/routes/orders.ts");
    now += 1000; bundle.note("c", "running", "Nightly audit"); bundle.note("c", "done", "Nightly audit");
    expect(bundle.content()).toEqual({
      title: "1 waiting · 1 running", state: "needs-input",
      threads: [
        { id: "b", title: "Add pagination", state: "waiting", startedAt: 1_001_000, askedAt: 1_002_000, reason: "Wants to edit src/routes/orders.ts" },
        { id: "a", title: "Fix flaky pairing test", state: "running", startedAt: 1_000_000 },
        { id: "c", title: "Nightly audit", state: "done", startedAt: 1_003_000, endedAt: 1_003_000 },
      ],
    });
    now += 16 * 60_000;
    expect(bundle.content().threads?.map((row) => row.id)).toEqual(["b", "a"]);
    for (const id of ["d", "e", "f"]) bundle.note(id.repeat(200), "failed", "x".repeat(200), "y".repeat(200));
    const content = bundle.content();
    expect(content.threads).toHaveLength(4);
    expect(Buffer.byteLength(JSON.stringify(content.threads))).toBeLessThanOrEqual(1_700);
    expect(content.threads?.[3]?.title).toHaveLength(60);
  });
});
