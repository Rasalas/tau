import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { candidatePlan, prepareCandidate, publishCandidate } from "./stable-candidate.mjs";

const repo = { owner: "Rasalas", repo: "tau" };
const sha = "a".repeat(40);
const merge = "b".repeat(40);
const old = {
  "package.json": JSON.stringify({ name: "tau", version: "0.7.40", dependencies: { pi: "1" } }),
  "package-lock.json": JSON.stringify({ version: "0.7.40", packages: { "": { version: "0.7.40" } } }),
  "kits/package.json": JSON.stringify({ name: "@tau/kits", version: "0.7.40" }),
};
const bumped = Object.fromEntries(Object.entries(old).map(([file, text]) => [file, text.replaceAll("0.7.40", "0.7.41")]));
const plan = (options = {}) => candidatePlan({ files: ["src/app.ts"], readFile: (_ref, file) => old[file], previous: "old", head: sha, ...options });
const pr = {
  number: 10, html_url: "https://github.com/Rasalas/tau/pull/10", merged: true, merge_commit_sha: merge,
  user: { login: "github-actions[bot]" }, head: { ref: "release/stable-0.7.41-123", repo: { full_name: "Rasalas/tau" } }, base: { ref: "main" },
};

function fixture() {
  const github = { rest: {
    repos: { getLatestRelease: vi.fn(async () => ({ data: { tag_name: "v0.7.40" } })), getReleaseByTag: vi.fn(async () => { throw { status: 404 }; }) },
    pulls: { list: vi.fn(async () => ({ data: [] })), create: vi.fn(async () => ({ data: pr })), update: vi.fn(), requestReviewers: vi.fn(), listFiles: vi.fn(async () => ({ data: [{ filename: "package.json" }, { filename: "package-lock.json" }] })) },
    issues: { addAssignees: vi.fn(), createComment: vi.fn() },
    git: {
      getCommit: vi.fn(async () => ({ data: { tree: { sha: "tree" } } })),
      createTree: vi.fn(async () => ({ data: { sha: "new-tree" } })),
      createCommit: vi.fn(async () => ({ data: { sha: "candidate" } })),
      createRef: vi.fn(), getRef: vi.fn(async () => { throw { status: 404 }; }),
    },
    actions: { createWorkflowDispatch: vi.fn(), listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [] } })) },
  } };
  github.paginate = async (method, args) => { const result = await method(args); return result.data.workflow_runs ?? result.data; };
  const checkout = {
    read: vi.fn((ref, file) => (ref === merge ? bumped : old)[file]),
    git: vi.fn((...args) => {
      if (args[0] === "rev-parse") return args[1].endsWith("^1") ? "parent" : sha;
      if (args[0] === "fetch") return "";
      if (args[0] === "diff" || args[0] === "diff-tree") return "src/app.ts";
      if (args[0] === "rev-list") return sha;
      if (args[0] === "show") return "fix: preserve thread model selection (#128)";
      throw new Error(`Unexpected git call: ${args}`);
    }),
  };
  return { github, repo, reviewer: "Rasalas", runId: 123, scheduled: true, checkout };
}

describe("stable candidate versions", () => {
  it("skips docs, tests and version-only changes", () => {
    for (const files of [["docs/RELEASE.md"], ["src/app.test.ts"], ["package.json", "package-lock.json"]]) expect(plan({ files })).toBeUndefined();
  });
  it("prepares a synchronized next patch without changing kits for core-only work", () => {
    const result = plan();
    expect(result.version).toBe("0.7.41");
    expect(Object.keys(result.updates)).toEqual(["package.json", "package-lock.json"]);
    expect(JSON.parse(result.updates["package-lock.json"]).packages[""].version).toBe("0.7.41");
    expect(result.kitsVersion).toBe("0.7.40");
  });
  it("bumps kits only when shipped kits changed", () => {
    expect(plan({ files: ["kits/workspace/desktop.tsx"] }).kitsVersion).toBe("0.7.41");
    expect(plan({ files: ["src/app.ts", "kits/workspace/desktop.test.tsx"] }).kitsVersion).toBe("0.7.40");
  });
  it("keeps deliberate unreleased version bumps", () => {
    expect(plan({ readFile: (ref, file) => (ref === "old" ? old : bumped)[file] }).version).toBe("0.7.41");
  });
  it("allows an explicit minor release but refuses reused or downgraded versions", () => {
    expect(plan({ requestedVersion: "0.8.0" }).version).toBe("0.8.0");
    for (const requestedVersion of ["0.7.40", "0.6.0", "0.7.41-nightly.1"]) expect(() => plan({ requestedVersion })).toThrow();
  });
  it("refuses mismatched lockfile versions", () => {
    expect(() => plan({ readFile: (_ref, file) => file === "package-lock.json" ? bumped[file] : old[file] })).toThrow(/versions differ/u);
  });
});

describe("weekly notifications and preparation", () => {
  it("creates a version-only PR, assigns and requests the reviewer, and explicitly starts both checks", async () => {
    const f = fixture();
    await expect(prepareCandidate(f)).resolves.toMatchObject({ version: "0.7.41", existing: false });
    expect(f.github.rest.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: [sha] }));
    expect(f.github.rest.git.createTree.mock.calls[0][0].tree.map((entry) => entry.path)).toEqual(["package.json", "package-lock.json"]);
    expect(f.github.rest.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ head: "release/stable-0.7.41-123", base: "main", body: expect.stringContaining("@Rasalas") }));
    expect(f.github.rest.issues.addAssignees).toHaveBeenCalledWith(expect.objectContaining({ assignees: ["Rasalas"] }));
    expect(f.github.rest.pulls.requestReviewers).toHaveBeenCalledWith(expect.objectContaining({ reviewers: ["Rasalas"] }));
    expect(f.github.rest.actions.createWorkflowDispatch.mock.calls.map(([args]) => args.workflow_id)).toEqual(["ci.yml", "performance.yml"]);
    expect(f.github.rest.git.createRef).not.toHaveBeenCalledWith(expect.objectContaining({ ref: expect.stringContaining("refs/tags/") }));
  });
  it("reminds on an existing candidate without rewriting its branch or creating duplicates", async () => {
    const f = fixture();
    f.github.rest.pulls.list.mockResolvedValue({ data: [pr] });
    await expect(prepareCandidate(f)).resolves.toMatchObject({ existing: true });
    expect(f.github.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("@Rasalas") }));
    expect(f.github.rest.git.createRef).not.toHaveBeenCalled();
    expect(f.github.rest.pulls.create).not.toHaveBeenCalled();
  });
  it("refuses to silently replace an open candidate with another requested version", async () => {
    const f = fixture();
    f.github.rest.pulls.list.mockResolvedValue({ data: [pr] });
    await expect(prepareCandidate({ ...f, requestedVersion: "0.8.0" })).rejects.toThrow(/Close the existing/u);
    expect(f.github.rest.git.createRef).not.toHaveBeenCalled();
  });
  it("closes a candidate superseded by a manual stable release", async () => {
    const f = fixture();
    f.github.rest.pulls.list.mockResolvedValue({ data: [pr] });
    f.github.rest.repos.getLatestRelease.mockResolvedValue({ data: { tag_name: "v0.7.41" } });
    f.checkout.git.mockImplementation((...args) => args[0] === "diff" ? "docs/RELEASE.md" : sha);
    await expect(prepareCandidate(f)).resolves.toEqual({ skipped: true });
    expect(f.github.rest.pulls.update).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 10, state: "closed" }));
  });
  it("does not send a weekly reminder for a manual hotfix dispatch", async () => {
    const f = fixture();
    f.github.rest.pulls.list.mockResolvedValue({ data: [pr] });
    await prepareCandidate({ ...f, scheduled: false });
    expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
  });
  it("does not create notifications when only docs or automation changed", async () => {
    const f = fixture();
    f.checkout.git.mockImplementation((...args) => args[0] === "diff" ? ".github/workflows/release.yml" : sha);
    await expect(prepareCandidate(f)).resolves.toEqual({ skipped: true });
    expect(f.github.rest.pulls.create).not.toHaveBeenCalled();
    expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
  });
});

describe("merging is the stable approval", () => {
  it("tags the exact merge commit and dispatches the release on that tag", async () => {
    const f = fixture();
    await expect(publishCandidate({ ...f, pr })).resolves.toEqual({ tag: "v0.7.41", sha: merge });
    expect(f.github.rest.git.createRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "refs/tags/v0.7.41", sha: merge }));
    expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ workflow_id: "release.yml", ref: "v0.7.41", inputs: { publish: "true" } }));
  });
  it.each([
    { ...pr, merged: false },
    { ...pr, user: { login: "somebody" } },
    { ...pr, head: { ...pr.head, repo: { full_name: "fork/tau" } } },
    { ...pr, head: { ...pr.head, ref: "feature/work" } },
  ])("ignores unmerged, foreign or ordinary PRs", async (other) => {
    const f = fixture();
    await expect(publishCandidate({ ...f, pr: other })).resolves.toEqual({ skipped: true });
    expect(f.github.rest.git.createRef).not.toHaveBeenCalled();
    expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });
  it("rejects non-version files and hidden dependency changes before tagging", async () => {
    for (const nonVersionFile of [true, false]) {
      const f = fixture();
      if (nonVersionFile) f.github.rest.pulls.listFiles.mockResolvedValue({ data: [{ filename: "src/app.ts" }] });
      else f.checkout.read.mockImplementation((ref, file) => ref === merge && file === "package.json" ? bumped[file].replace('"pi":"1"', '"pi":"2"') : (ref === merge ? bumped : old)[file]);
      await expect(publishCandidate({ ...f, pr })).rejects.toThrow();
      expect(f.github.rest.git.createRef).not.toHaveBeenCalled();
    }
  });
  it("refuses to replace another commit's tag or publish behind a newer stable", async () => {
    const f = fixture();
    f.github.rest.git.getRef.mockResolvedValue({ data: { object: { sha } } });
    await expect(publishCandidate({ ...f, pr })).rejects.toThrow(/another commit/u);
    f.github.rest.repos.getLatestRelease.mockResolvedValue({ data: { tag_name: "v0.7.42" } });
    await expect(publishCandidate({ ...f, pr })).rejects.toThrow(/newer stable/u);
    expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });
  it("does not dispatch twice while the approved release is running", async () => {
    const f = fixture();
    f.github.rest.git.getRef.mockResolvedValue({ data: { object: { sha: merge } } });
    f.github.rest.actions.listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [{ head_branch: "v0.7.41", status: "in_progress" }] } });
    await expect(publishCandidate({ ...f, pr })).resolves.toMatchObject({ dispatched: true });
    expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });
  it("can retry a failed build on the same immutable tag", async () => {
    const f = fixture();
    f.github.rest.git.getRef.mockResolvedValue({ data: { object: { sha: merge } } });
    f.github.rest.actions.listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [{ head_branch: "v0.7.41", status: "completed", conclusion: "failure" }] } });
    await publishCandidate({ ...f, pr });
    expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
    expect(f.github.rest.git.createRef).not.toHaveBeenCalled();
  });
});

it("schedules Berlin Tuesdays, publishes only merged candidates, and queues both release channels", () => {
  const candidate = readFileSync(new URL("../../.github/workflows/stable-candidate.yml", import.meta.url), "utf8");
  const release = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  expect(candidate).toContain("cron: '15 10 * * 2'");
  expect(candidate).toContain("timezone: Europe/Berlin");
  expect(candidate).toContain("types: [closed]");
  expect(candidate).toContain("github.event.pull_request.merged == true");
  expect(candidate).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  expect(release).toContain("'release-publish'");
  expect(release).toContain("queue: max");
  expect(release).not.toContain("cancel-in-progress: true");
  for (const [, action] of candidate.matchAll(/uses: \S+@(\S+)/gu)) expect(action).toMatch(/^[0-9a-f]{40}$/u);
});
