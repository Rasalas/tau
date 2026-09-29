import { describe, expect, it, vi } from "vitest";
import { REQUIRED_WORKFLOWS, decide, verification } from "./verified-commit.mjs";

const SHA = "1099ab01".padEnd(40, "0");
const run = (path, overrides = {}) => ({ path, head_sha: SHA, event: "push", status: "completed", conclusion: "success", ...overrides });
const GREEN = [run(".github/workflows/ci.yml"), run(".github/workflows/performance.yml"), run(".github/workflows/release.yml", { status: "in_progress", conclusion: null })];

describe("a commit CI already verified", () => {
  it("needs a successful run of CI and of the performance gates on that commit", () => {
    expect(REQUIRED_WORKFLOWS).toEqual([".github/workflows/ci.yml", ".github/workflows/performance.yml"]);
    expect(verification(GREEN, SHA)).toEqual({ verified: true, missing: [] });
  });

  it("is not verified while a run is missing, running, red or on another commit", () => {
    const without = GREEN.filter((entry) => entry.path !== ".github/workflows/performance.yml");
    expect(verification(without, SHA)).toEqual({ verified: false, missing: [".github/workflows/performance.yml"] });
    expect(verification([...without, run(".github/workflows/performance.yml", { status: "in_progress", conclusion: null })], SHA).verified).toBe(false);
    expect(verification([...without, run(".github/workflows/performance.yml", { conclusion: "failure" })], SHA).verified).toBe(false);
    expect(verification([...without, run(".github/workflows/performance.yml", { conclusion: "cancelled" })], SHA).verified).toBe(false);
    expect(verification([...without, run(".github/workflows/performance.yml", { head_sha: "f".repeat(40) })], SHA).verified).toBe(false);
  });

  it("counts a pull request's run only as the merge commit it tested, not as this one", () => {
    const fromPullRequest = GREEN.map((entry) => ({ ...entry, event: "pull_request" }));
    expect(verification(fromPullRequest, SHA).verified).toBe(false);
    expect(verification(GREEN.map((entry) => ({ ...entry, event: "workflow_dispatch" })), SHA).verified).toBe(true);
  });

  it("takes one green run when a commit has a red one too", () => {
    expect(verification([...GREEN, run(".github/workflows/ci.yml", { conclusion: "failure" })], SHA).verified).toBe(true);
  });
});

describe("the gate's answer", () => {
  const answer = (body, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 403, json: async () => body }));

  it("asks for the runs of exactly this commit", async () => {
    const fetchUrl = answer({ workflow_runs: GREEN });
    expect(await decide({ repository: "Rasalas/tau", sha: SHA, token: "t", fetchUrl })).toMatchObject({ verified: true });
    const [url, init] = fetchUrl.mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/Rasalas/tau/actions/runs?head_sha=${SHA}&per_page=100`);
    expect(init.headers.authorization).toBe("Bearer t");
  });

  it("verifies itself when the API fails or the SHA is not one", async () => {
    expect(await decide({ repository: "Rasalas/tau", sha: SHA, token: "t", fetchUrl: answer({}, false) })).toMatchObject({ verified: false, reason: expect.stringMatching(/403/u) });
    expect(await decide({ repository: "Rasalas/tau", sha: SHA, token: "t", fetchUrl: vi.fn(async () => { throw new Error("offline"); }) })).toMatchObject({ verified: false });
    expect(await decide({ repository: "Rasalas/tau", sha: "main", token: "t", fetchUrl: answer({ workflow_runs: GREEN }) })).toMatchObject({ verified: false });
    expect(await decide({ repository: "Rasalas/tau", sha: SHA, token: "t", fetchUrl: answer({ workflow_runs: [] }) })).toMatchObject({ verified: false, reason: expect.stringMatching(/ci\.yml and .*performance\.yml/u) });
  });
});
