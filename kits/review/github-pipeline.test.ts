import { describe, expect, it, vi } from "vitest";
import { createGitHubPipelines } from "./github-pipeline.js";
import type { ProviderTools } from "./provider.js";
import type { PullRequestRef } from "./protocol.js";

const REF: PullRequestRef = { service: "github", host: "github.com", repo: "acme/demo", number: 7, url: "https://github.com/acme/demo/pull/7" };
const FILE = "jobs:\n  lint:\n    runs-on: x\n  test:\n    needs: lint\n";
const job = (name: string, seconds: number) => ({ name, conclusion: "success", started_at: "2026-10-01T10:00:00Z", completed_at: new Date(Date.parse("2026-10-01T10:00:00Z") + seconds * 1000).toISOString() });

function tools(now = { at: 0 }) {
  const answers: Record<string, unknown> = {
    "repos/acme/demo": { default_branch: "trunk" },
    "repos/acme/demo/actions/workflows?per_page=100": { workflows: [{ id: 9, name: "CI", path: ".github/workflows/ci.yml" }] },
    "repos/acme/demo/contents/.github/workflows/ci.yml?ref=trunk": { content: Buffer.from(FILE).toString("base64"), encoding: "base64" },
    "repos/acme/demo/actions/runs/42": { workflow_id: 9, path: ".github/workflows/ci.yml", head_sha: "abc" },
    "repos/acme/demo/contents/.github/workflows/ci.yml?ref=abc": { content: Buffer.from(FILE).toString("base64"), encoding: "base64" },
    "repos/acme/demo/actions/workflows/9/runs?branch=trunk&status=success&exclude_pull_requests=true&per_page=5": { workflow_runs: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    "repos/acme/demo/actions/runs/1/jobs?per_page=100": { jobs: [job("lint", 60), job("test", 300)] },
    "repos/acme/demo/actions/runs/2/jobs?per_page=100": { jobs: [job("lint", 40), job("test", 200)] },
    "repos/acme/demo/actions/runs/3/jobs?per_page=100": { jobs: [job("lint", 50)] },
  };
  const cli = vi.fn(async (_kind: string, call: { args: string[] }) => {
    const path = call.args.at(-1)!;
    if (!(path in answers)) throw new Error(`no answer for ${path}`);
    return JSON.stringify(answers[path]);
  });
  return { cli, now: () => now.at } as unknown as ProviderTools & { cli: typeof cli };
}

describe("GitHub pipeline facts", () => {
  it("reads a run's workflow file and the usual durations on the default branch", async () => {
    const fake = tools();
    const read = createGitHubPipelines(fake);
    expect(await read(REF, ["42", "42", "not-a-run"])).toEqual({
      42: { jobs: [{ id: "lint", needs: [] }, { id: "test", needs: ["lint"] }], expected: { lint: 50_000, test: 250_000 } },
    });
    // Only `gh api` reads, every one against the request's host.
    expect(fake.cli.mock.calls.every(([kind, call]) => kind === "github" && call.args[0] === "api" && call.args.includes("github.com") && !call.args.includes("--method"))).toBe(true);
  });

  it("asks nothing again while the cache holds, and the durations again after hours", async () => {
    const clock = { at: 0 };
    const fake = tools(clock);
    const read = createGitHubPipelines(fake);
    await read(REF, ["42"]);
    const first = fake.cli.mock.calls.length;
    await read(REF, ["42"]);
    expect(fake.cli.mock.calls.length).toBe(first);
    clock.at = 7 * 3_600_000;
    await read(REF, ["42"]);
    const again = fake.cli.mock.calls.slice(first).map(([, call]) => call.args.at(-1));
    expect(again).toContain("repos/acme/demo/actions/workflows/9/runs?branch=trunk&status=success&exclude_pull_requests=true&per_page=5");
    expect(again).not.toContain("repos/acme/demo/actions/runs/42");
  });

  it("leaves out a run it cannot read and keeps the rest", async () => {
    const read = createGitHubPipelines(tools());
    expect(Object.keys(await read(REF, ["42", "999"]))).toEqual(["42"]);
  });

  it("reads a list's rows by workflow name: the file on the default branch, once for every request of the repository", async () => {
    const fake = tools();
    const read = createGitHubPipelines(fake);
    const facts = await read(REF, ["42", "43", "44"], { 42: "CI", 43: "CI", 44: "Gone" });
    expect(Object.keys(facts)).toEqual(["42", "43"]);
    expect(facts[43]).toEqual({ jobs: [{ id: "lint", needs: [] }, { id: "test", needs: ["lint"] }], expected: { lint: 50_000, test: 250_000 } });
    const before = fake.cli.mock.calls.length;
    await read({ ...REF, number: 8, url: "https://github.com/acme/demo/pull/8" }, ["50"], { 50: "CI" });
    expect(fake.cli.mock.calls.length).toBe(before);
    const paths = fake.cli.mock.calls.map(([, call]) => call.args.at(-1));
    expect(paths).not.toContain("repos/acme/demo/actions/runs/42");
    expect(paths.filter((path) => path === "repos/acme/demo/actions/workflows?per_page=100")).toHaveLength(1);
  });
});
