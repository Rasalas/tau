import { describe, expect, it } from "vitest";
import type { UiSession } from "tau";
import { diffStatLabel, threadDetails } from "./rail-details.js";

const session: UiSession = { id: "t", path: "/s/t.jsonl", title: "Fix the rail", modifiedAt: 0, projectPath: "/repo", projectName: "tau", projectLabel: "feature/rail", messageCount: 2 };

describe("threadDetails", () => {
  it("names the thread, its project, branch, age and last turn", () => {
    expect(threadDetails({ session, age: "5m", stat: { added: 12, removed: 3, files: 1, at: 1 } }))
      .toBe("Fix the rail\ntau\nOn feature/rail\nUpdated 5m ago\nLast turn +12 −3 in 1 file");
  });

  it("says the state and why in place of the age", () => {
    const { projectLabel: _branch, ...plain } = session;
    expect(threadDetails({ session: plain, age: "Sep 3", status: "Failed", hint: "stream disconnected" }))
      .toBe("Fix the rail\ntau\nFailed: stream disconnected");
    expect(threadDetails({ session: plain, age: "Sep 3" })).toBe("Fix the rail\ntau\nUpdated on Sep 3");
    expect(threadDetails({ session: plain, age: "now" })).toBe("Fix the rail\ntau\nUpdated just now");
  });

  it("writes a diff stat with a real minus sign", () => {
    expect(diffStatLabel({ added: 0, removed: 7, files: 2, at: 0 })).toBe("+0 −7");
  });
});
