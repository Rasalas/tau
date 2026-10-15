import { describe, expect, it } from "vitest";
import { createCheckProbe, parseIncluded, probeOf } from "./github-check-probe.js";
import type { CliOptions, ProviderTools } from "./provider.js";
import { createGitHubProvider } from "./provider-github.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { CliFailure } from "./request-cli.js";

const REF = parseRequestUrl("https://github.com/acme/tau/pull/7")!;
const RUN = "https://github.com/acme/tau/actions/runs/77/job/";
const included = (status: string, etag: string, body?: unknown) => `HTTP/2.0 ${status}\r\nContent-Type: application/json\r\nEtag: ${etag}\r\n\r\n${body === undefined ? "" : JSON.stringify(body)}`;
const RUNS = { total_count: 2, check_runs: [
  { id: 1, name: "lint", status: "completed", conclusion: "success", head_sha: "abc", details_url: `${RUN}1`, started_at: "2026-10-15T08:00:00Z", completed_at: "2026-10-15T08:01:00Z" },
  { id: 2, name: "test", status: "queued", conclusion: null, head_sha: "abc", details_url: `${RUN}2` },
] };
const STATUS = { state: "pending", sha: "abc", total_count: 0, statuses: [] };

/** A `gh` that answers check runs and statuses, 304 for a matching If-None-Match as gh does: exit 1 with the answer on stdout. */
function fakeGh(answers: { runs: { etag: string; body: unknown }; status: { etag: string; body: unknown } }) {
  const calls: string[][] = [];
  const cli = async (_kind: string, call: { args: string[] }, _action: string, options: CliOptions = {}) => {
    calls.push(call.args);
    const path = call.args.at(-1)!;
    if (call.args[0] === "pr") return JSON.stringify({ statusCheckRollup: [{ name: "lint", conclusion: "SUCCESS", detailsUrl: `${RUN}1` }] });
    const answer = path.includes("/check-runs") ? answers.runs : answers.status;
    const sent = call.args[call.args.indexOf("-H") + 1];
    if (call.args.includes("-H") && sent === `If-None-Match: ${answer.etag}`) {
      const stdout = included("304 Not Modified", answer.etag);
      if (options.acceptFailure?.(stdout, 1)) return stdout;
      throw new CliFailure("gh: HTTP 304", stdout, "gh: HTTP 304", 1);
    }
    return included("200 OK", answer.etag, answer.body);
  };
  return { calls, cli: cli as unknown as ProviderTools["cli"] };
}

describe("conditional check reads", () => {
  it("reads the status, ETag and body of an included answer", () => {
    expect(parseIncluded(included("200 OK", 'W/"a"', { ok: true }))).toEqual({ status: 200, etag: 'W/"a"', body: { ok: true } });
    expect(parseIncluded(included("304 Not Modified", 'W/"a"'))).toEqual({ status: 304, etag: 'W/"a"' });
  });

  it("asks with the last ETag, keeps the held answer on a 304 and follows the request's head ref", async () => {
    const gh = fakeGh({ runs: { etag: 'W/"r1"', body: RUNS }, status: { etag: 'W/"s1"', body: STATUS } });
    const probe = createCheckProbe();
    const first = await probe(gh.cli, REF);
    expect(gh.calls.map((args) => args.at(-1))).toEqual([
      "repos/acme/tau/commits/refs/pull/7/head/check-runs?per_page=100",
      "repos/acme/tau/commits/refs/pull/7/head/status?per_page=100",
    ]);
    expect(gh.calls[0]).not.toContain("-H");
    const second = await probe(gh.cli, REF);
    expect(gh.calls[2]).toEqual(expect.arrayContaining(["--include", "-H", 'If-None-Match: W/"r1"']));
    expect(second).toEqual(first);
    expect(first).toMatchObject({ tag: 'W/"r1" W/"s1"', head: "abc", pending: true, failed: [], partial: false });
    expect(first.checks).toEqual([
      { name: "lint", status: "passed", url: `${RUN}1`, startedAt: "2026-10-15T08:00:00Z", completedAt: "2026-10-15T08:01:00Z" },
      { name: "test", status: "pending", url: `${RUN}2`, queued: true },
    ]);
  });

  it("names failures the way a watch does and does not count an empty combined status as pending", () => {
    const probe = probeOf("t", { total_count: 101, check_runs: [{ id: 9, name: "smoke", status: "completed", conclusion: "timed_out" }] }, {
      state: "failure", sha: "def", total_count: 1, statuses: [{ context: "deploy", state: "error", target_url: "https://ci.example/1" }],
    });
    expect(probe).toMatchObject({ head: "def", pending: false, partial: true, failed: [{ id: "9", name: "smoke" }, { id: "deploy https://ci.example/1", name: "deploy" }] });
    expect(probeOf("t", { total_count: 0, check_runs: [] }, STATUS).pending).toBe(false);
  });

  it("serves a request's checks again while GitHub answers 304, and reads them anew once a tag moves", async () => {
    const answers = { runs: { etag: 'W/"r1"', body: RUNS }, status: { etag: 'W/"s1"', body: STATUS } };
    const gh = fakeGh(answers);
    let time = 0;
    const provider = createGitHubProvider({ cli: gh.cli, now: () => time } as unknown as ProviderTools);
    const rollups = () => gh.calls.filter((args) => args[0] === "pr").length;
    await provider.checks(REF);
    await provider.checks(REF);
    expect(rollups()).toBe(1);
    answers.runs = { etag: 'W/"r2"', body: RUNS };
    await provider.checks(REF);
    expect(rollups()).toBe(2);
    // However quiet, the rollup is read again after a few minutes.
    time += 5 * 60_000;
    await provider.checks(REF);
    expect(rollups()).toBe(3);
  });
});
