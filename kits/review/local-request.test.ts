import { describe, expect, it } from "vitest";
import { assignEvidence, evidenceToken, findEvidenceTokens, insertEvidence, LocalDrafts, replaceEvidenceTokens, type LocalCommit, type LocalEvidence } from "./local-request.js";

const frame = (threadId: string, turnId: string, endedAt: number, id = `${turnId}-f`): LocalEvidence => ({
  threadId, source: "tau.evidence", id, turnId, turnStartedAt: endedAt - 5_000, turnEndedAt: endedAt, at: endedAt - 1_000,
  mediaType: "image/jpeg", size: 10, width: 960, height: 600, caption: `Frame ${id}`,
});
const commit = (sha: string, at: number): LocalCommit => ({ sha, subject: `commit ${sha}`, body: "", at });

describe("local pull request logic", () => {
  it("gives each turn to the first commit at or after its end, newest group first", () => {
    const commits = [commit("b", 20_000), commit("a", 10_000)];
    const groups = assignEvidence(commits, [frame("t", "early", 5_000), frame("t", "one", 9_500), frame("t", "same-second", 10_400), frame("t", "two", 15_000), frame("u", "later", 30_000)], 8_000);
    expect(groups.map((group) => [group.commit?.sha ?? "uncommitted", group.turns.map((turn) => turn.turnId)])).toEqual([
      ["uncommitted", ["later"]],
      ["b", ["two"]],
      ["a", ["one", "same-second"]],
    ]);
  });

  it("round-trips a picture through its token and takes out the ones that stay local", () => {
    const media = { threadId: "thread 1", source: "tau.evidence", id: "f/1", caption: "Clicked [Save]\nthen" };
    const token = evidenceToken(media);
    expect(token).toBe("![Clicked Save then](tau-evidence://thread%201/tau.evidence/f%2F1)");
    const body = insertEvidence("## Summary\nIt works.", [media, { ...media, id: "f2", caption: "After" }]);
    expect(findEvidenceTokens(body).map((entry) => entry.id)).toEqual(["f/1", "f2"]);
    expect(replaceEvidenceTokens(body, (entry) => `![${entry.caption}](https://x/${entry.id})`)).toContain("![After](https://x/f2)");
    expect(replaceEvidenceTokens(body, () => undefined)).toBe("## Summary\nIt works.");
    expect(replaceEvidenceTokens(`Before ${token} after`, () => undefined)).toBe("Before  after");
  });

  it("keeps a draft per checkout and branch", () => {
    const map = new Map<string, string>();
    const storage = { get: (key: string) => map.get(key) ?? null, set: (key: string, value: string) => { map.set(key, value); }, remove: (key: string) => { map.delete(key); }, keys: () => [...map.keys()] };
    const drafts = new LocalDrafts(() => storage, () => 1);
    drafts.set("/repo", "feature", { title: "T", body: "B", base: "main", draft: false, selected: ["k"] });
    expect(drafts.get("/repo", "feature")).toMatchObject({ title: "T", selected: ["k"] });
    expect(drafts.get("/repo", "other")).toBeUndefined();
    drafts.clear("/repo", "feature");
    expect(drafts.get("/repo", "feature")).toBeUndefined();
  });
});
