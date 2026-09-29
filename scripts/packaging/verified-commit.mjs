#!/usr/bin/env node
// Whether CI and the performance gates already passed on exactly this commit,
// so the release workflow can leave out its own verify job. Prints
// `verified=true|false` for $GITHUB_OUTPUT; the reason goes to stderr. Any
// doubt, an API error included, answers false and the release verifies itself.
//
//   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/packaging/verified-commit.mjs <sha>
import { isMain, main } from "./release.mjs";

/** The workflows whose success on a commit stands in for the verify job. */
export const REQUIRED_WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/performance.yml"];

// A pull request's run tests a merge commit, not this one.
const EXACT_EVENTS = new Set(["push", "workflow_dispatch"]);

/** `{ verified, missing }`: the required workflows without a successful run on `sha`. */
export function verification(runs, sha) {
  const passed = new Set(runs
    .filter((run) => run.head_sha === sha && EXACT_EVENTS.has(run.event) && run.status === "completed" && run.conclusion === "success")
    .map((run) => run.path));
  const missing = REQUIRED_WORKFLOWS.filter((path) => !passed.has(path));
  return { verified: missing.length === 0, missing };
}

export async function workflowRuns({ repository, sha, token, fetchUrl = fetch }) {
  const url = `https://api.github.com/repos/${repository}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`;
  const response = await fetchUrl(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()).workflow_runs ?? [];
}

/** The line for $GITHUB_OUTPUT and why. */
export async function decide({ repository, sha, token, fetchUrl }) {
  if (!/^[0-9a-f]{40}$/u.test(sha ?? "")) return { verified: false, reason: `"${sha}" is not a commit SHA; the release verifies itself.` };
  let runs;
  try {
    runs = await workflowRuns({ repository, sha, token, fetchUrl });
  } catch (error) {
    return { verified: false, reason: `Could not read the workflow runs (${error instanceof Error ? error.message : String(error)}); the release verifies itself.` };
  }
  const { verified, missing } = verification(runs, sha);
  return verified
    ? { verified, reason: `${REQUIRED_WORKFLOWS.join(" and ")} passed on ${sha}; the release skips its own verify job.` }
    : { verified, reason: `No successful run of ${missing.join(" and ")} on ${sha} yet; the release verifies itself.` };
}

if (isMain(import.meta.url)) {
  main(async () => {
    const [sha] = process.argv.slice(2);
    const { verified, reason } = await decide({ repository: process.env.GITHUB_REPOSITORY, sha, token: process.env.GITHUB_TOKEN });
    console.error(reason);
    console.log(`verified=${verified}`);
  });
}
