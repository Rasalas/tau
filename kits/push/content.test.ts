import { describe, expect, it } from "vitest";
import { composePush, excerpt, lastAgentText } from "./content.js";

describe("what a push says", () => {
  it("takes the first line with words, plain, at most a hundred characters", () => {
    expect(excerpt("\n\n## Fixed the **build**\nMore below")).toBe("Fixed the build");
    expect(excerpt("```ts\nconst a = 1;\n```\n- Updated `vite.config.ts` and [the docs](https://x)")).toBe("Updated vite.config.ts and the docs");
    const long = excerpt("word ".repeat(60));
    expect([...long!].length).toBeLessThanOrEqual(100);
    expect(long!.endsWith("…")).toBe(true);
    expect(excerpt("   \n```\ncode only\n```")).toBeUndefined();
  });

  it("says the title and the excerpt, or the title and what happened when the user chose titles only", () => {
    expect(composePush({ kind: "completed", title: "Fix the build", text: "Done: the tests pass.\nDetails" }, "excerpt")).toEqual({ title: "Fix the build", body: "Done: the tests pass." });
    expect(composePush({ kind: "completed", title: "Fix the build", text: "Done: the tests pass." }, "title")).toEqual({ title: "Fix the build", body: "Finished" });
    expect(composePush({ kind: "failed", title: "Fix the build", text: "The model refused." }, "excerpt")).toEqual({ title: "Fix the build", body: "Failed: The model refused." });
    expect(composePush({ kind: "failed" }, "excerpt")).toEqual({ title: "A thread", body: "Failed" });
  });

  it("gives the reason for a hand-over and the question itself", () => {
    expect(composePush({ kind: "turn", title: "Deploy", text: "Sign in to the staging dashboard" }, "excerpt")).toEqual({ title: "Deploy", body: "Your turn: Sign in to the staging dashboard" });
    expect(composePush({ kind: "question", title: "Deploy", text: "Which region?" }, "excerpt")).toEqual({ title: "Deploy", body: "Which region?" });
    expect(composePush({ kind: "approval", title: "Deploy", text: "Allow bash? — rm -rf dist" }, "title")).toEqual({ title: "Deploy", body: "Needs your permission" });
  });

  it("reads the agent's words of the turn that ended, never an older turn's", () => {
    expect(lastAgentText([{ role: "user", text: "go" }, { role: "assistant", text: "first" }, { role: "notice", text: "x" }, { role: "assistant", text: "" }])).toBe("first");
    expect(lastAgentText([{ role: "assistant", text: "old answer" }, { role: "user", text: "go again" }])).toBeUndefined();
  });
});
