import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequestListEntry } from "./protocol.js";
import { parseGitHubList } from "./pull-request-list-json.js";
import {
  arrangeList,
  decodeListPreferences,
  listFacets,
  matchesListFilters,
  parseListQuery,
  rankBlockedOnAuthor,
  rankByMergeReadiness,
} from "./pull-request-list-logic.js";

let serial = 0;
function entry(patch: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  serial += 1;
  const number = patch.ref?.number ?? serial;
  return {
    ref: { service: "github", host: "github.com", repo: "acme/tau", number, url: `https://github.com/acme/tau/pull/${number}` },
    title: `Change ${number}`,
    author: { login: "someone" },
    headRef: `branch-${number}`,
    baseRef: "main",
    state: "open",
    draft: false,
    additions: 10,
    deletions: 2,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: `2026-09-${String(10 + (number % 10)).padStart(2, "0")}T00:00:00Z`,
    labels: [],
    reviewRequested: false,
    ...patch,
  };
}
const numbers = (entries: readonly PullRequestListEntry[]) => entries.map((item) => item.ref.number);
const at = (number: number, patch: Partial<PullRequestListEntry> = {}) => entry({ ...patch, ref: { service: "github", host: "github.com", repo: "acme/tau", number, url: `https://github.com/acme/tau/pull/${number}` } });

describe("the typed query", () => {
  it("reads GitHub's qualifiers and leaves the rest as text for the host", () => {
    expect(parseListQuery('fix wizard label:bug,docs -label:"needs design" author:me draft:false review:approved status:failure size:XL')).toEqual({
      text: "fix wizard",
      filters: {
        author: "me",
        draft: "hide",
        review: "approved",
        checks: "failing",
        labels: [["bug", "docs"], ["size:XL"]],
        excludedLabels: ["needs design"],
      },
    });
    // A value it does not take, a quoted token and a pasted link stay text.
    expect(parseListQuery('review:maybe "size:XL" https://example.com').text).toBe('review:maybe "size:XL" https://example.com');
  });

  it("narrows by the row's own fields, author:me by the signed-in login", () => {
    const row = at(1, { labels: [{ name: "Bug" }], author: { login: "Octo" }, draft: true, reviewDecision: "approved", checks: "passing" });
    expect(matchesListFilters(row, { labels: [["bug", "docs"]], author: "me", draft: "only", review: "approved", checks: "passing" }, "octo")).toBe(true);
    expect(matchesListFilters(row, { excludedLabels: ["bug"] })).toBe(false);
    expect(matchesListFilters(row, { review: "none" })).toBe(false);
    expect(matchesListFilters(row, { author: "me" })).toBe(false);
  });
});

describe("ordering", () => {
  it("puts green approved work first and a conflict last for merge readiness", () => {
    const ranked = rankByMergeReadiness([
      at(1, { mergeable: "conflicting", checks: "passing", reviewDecision: "approved" }),
      at(2, { checks: "passing" }),
      at(3, { checks: "passing", reviewDecision: "approved", additions: 500 }),
      at(4, { checks: "passing", reviewDecision: "approved", additions: 1 }),
      at(5, { state: "merged" }),
      at(6, { draft: true, checks: "passing", reviewDecision: "approved" }),
    ]);
    expect(numbers(ranked)).toEqual([4, 3, 2, 6, 5, 1]);
  });

  it("sorts an author's own work by what blocks it: conflict, changes requested, red checks, draft", () => {
    const ranked = rankBlockedOnAuthor([
      at(1, { checks: "passing", reviewDecision: "approved" }),
      at(2, { draft: true }),
      at(3, { checks: "failing" }),
      at(4, { reviewDecision: "changes-requested" }),
      at(5, { mergeable: "conflicting" }),
      at(6, { state: "closed", mergeable: "conflicting" }),
      at(7, {}),
    ]);
    expect(numbers(ranked)).toEqual([5, 4, 3, 2, 7, 1, 6]);
  });

  it("groups authored work first and orders each group for the role it plays", () => {
    const rows = [
      at(1, { author: { login: "me" }, checks: "passing", reviewDecision: "approved" }),
      at(2, { author: { login: "me" }, reviewDecision: "changes-requested" }),
      at(3, { reviewRequested: true, state: "closed" }),
      at(4, { reviewRequested: true, updatedAt: "2026-09-20T00:00:00Z" }),
      at(5, {}),
    ];
    const blocked = arrangeList(rows, { viewer: "me", involvement: "all", sort: "blocked", query: "", menu: {} });
    expect(blocked.groups.map((group) => [group.label, numbers(group.entries)])).toEqual([
      ["Authored", [2, 1]],
      ["Review requested", [4, 3]],
      ["Others", [5]],
    ]);
    const reviewing = arrangeList(rows, { viewer: "me", involvement: "reviewing", sort: "blocked", query: "", menu: {} });
    expect(reviewing.groups.map((group) => numbers(group.entries))).toEqual([[4, 3]]);
    expect(arrangeList(rows, { viewer: "me", involvement: "all", sort: "ready", query: "draft:true", menu: {} }).shown).toBe(0);
  });

  it("orders a search by how well the row itself matches", () => {
    const rows = [at(1, { title: "Unrelated" }), at(2, { title: "Fix the wizard" }), at(3, { title: "Wizard" })];
    expect(arrangeList(rows, { involvement: "all", sort: "ready", query: "wizard", menu: {} }).groups[0]!.entries.map((row) => row.ref.number)).toEqual([3, 2, 1]);
    expect(arrangeList(rows, { involvement: "all", sort: "ready", query: "#2", menu: {} }).groups[0]!.entries[0]!.ref.number).toBe(2);
  });
});

describe("the list's parts", () => {
  it("reads a recorded `gh pr list` and counts its labels and authors", async () => {
    const rows = parseGitHubList(await readFile(join(import.meta.dirname, "fixtures", "gh-pr-list.json"), "utf8"), undefined);
    expect(rows.map((row) => row.state)).toEqual(["open", "open", "open", "open", "merged", "closed"]);
    expect(rows.find((row) => row.state === "merged")?.reviewDecision).toBe("approved");
    expect(rows.find((row) => row.state === "merged")?.mergeable).toBeUndefined();
    const facets = listFacets(rows);
    expect(facets.labels.slice(0, 2)).toEqual([expect.objectContaining({ name: "external", count: 2 }), expect.objectContaining({ name: "ready-for-review", count: 2 })]);
    expect(facets.authors.length).toBeGreaterThan(0);
  });

  it("keeps each remembered control that is valid and drops the rest", () => {
    expect(decodeListPreferences('{"state":"merged","sort":"sideways","involvement":"authored","draft":"hide"}')).toEqual({ state: "merged", involvement: "authored", sort: "ready", draft: "hide" });
    expect(decodeListPreferences("not json")).toEqual({ state: "open", involvement: "all", sort: "ready" });
  });
});
