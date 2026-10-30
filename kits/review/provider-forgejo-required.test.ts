import { describe, expect, it, vi } from "vitest";
import { createForgejoProvider } from "./provider-forgejo.js";
import type { ProviderTools } from "./provider.js";
import type { PullRequestRef } from "./protocol.js";

const ref: PullRequestRef = { service: "forgejo", host: "forge.test", repo: "acme/repo", number: 1, url: "https://forge.test/acme/repo/pulls/1" };
function harness(options: { branch?: unknown; branchStatus?: number; infinite?: boolean; invalid?: boolean; link?: boolean; remarks?: boolean } = {}) {
  const paths: string[] = [];
  const cli: ProviderTools["cli"] = vi.fn(async (_kind, call, _action, config) => {
    if (call.args[0] === "login") return JSON.stringify([{ name: "forge", url: "https://forge.test", default: true }]);
    const url = new URL(call.args.at(-1)!);
    paths.push(url.pathname + url.search);
    let body: unknown = [];
    let status = 200;
    let headers = "";
    if (url.pathname.endsWith("/pulls/1")) body = { title: "Checks", state: "open", head: { sha: "head" }, base: { ref: "release/1.x" } };
    if (url.pathname.includes("/branches/")) { body = options.branch ?? { protected: true, enable_status_check: true, status_check_contexts: ["build", "deploy"] }; status = options.branchStatus ?? 200; }
    if (options.remarks && url.pathname.endsWith("/comments")) body = Number(url.searchParams.get("page")) === 1 ? [{ id: 1, body: "first", updated_at: "one" }] : Number(url.searchParams.get("page")) === 2 ? [{ id: 2, body: "last", updated_at: "two" }] : [];
    if (url.pathname.includes("/statuses/")) {
      const page = Number(url.searchParams.get("page"));
      body = options.invalid ? {} : page === 1 || options.infinite ? [{ context: "build", status: "success", target_url: "/run/1" }] : page === 2 ? [{ context: "lint", status: "failure" }] : [];
      if (options.link) headers = page === 1 ? '\nLink: <https://forge.test/page2>; rel="next"' : '\nLink: <https://forge.test/page1>; rel="prev"';
    }
    const output = JSON.stringify(body);
    config?.inspect?.(output, `HTTP/2.0 ${status} OK${headers}`);
    return output;
  });
  const tools = { cli, now: () => 0, cached: (_kind: string, _ref: unknown, _fresh: boolean, read: () => unknown) => read() } as unknown as ProviderTools;
  return { provider: createForgejoProvider(tools), paths };
}

describe("Forgejo checks through provider responses", () => {
  it("uses every status page even when the server caps the requested page size; both reads apply policy", async () => {
    const { provider, paths } = harness();
    for (const checks of [await provider.checks(ref), (await provider.detail(ref, true)).checks]) {
      expect(checks).toMatchObject([{ name: "build", required: true, status: "passed" }, { name: "lint", required: false, status: "failed" }, { name: "deploy", required: true, status: "pending", expected: true }]);
    }
    expect(paths).toContain("/api/v1/repos/acme/repo/branches/release%2F1.x");
    expect(paths).toContain("/api/v1/repos/acme/repo/statuses/head?sort=recentupdate&limit=50&page=3");
  });
  it("honours a final Link page", async () => {
    const { provider, paths } = harness({ link: true });
    await provider.checks(ref);
    expect(paths.filter((path) => path.includes("/statuses/"))).toHaveLength(2);
  });
  it.each([403, 404])("treats HTTP %i branch metadata as unknown", async (branchStatus) => {
    const { provider } = harness({ branchStatus });
    expect(await provider.checks(ref)).toMatchObject([{ name: "build", requirementUnknown: true }, { name: "lint", requirementUnknown: true }]);
  });
  it.each([401, 429, 503])("propagates HTTP %i instead of claiming successful empty checks", async (branchStatus) => {
    const { provider } = harness({ branchStatus });
    await expect(provider.checks(ref)).rejects.toThrow(`HTTP ${branchStatus}`);
    await expect(provider.detail(ref, true)).rejects.toThrow(`HTTP ${branchStatus}`);
  });
  it("rejects malformed or truncated status coverage", async () => {
    await expect(harness({ invalid: true }).provider.checks(ref)).rejects.toThrow("readable status page");
    await expect(harness({ infinite: true }).provider.checks(ref)).rejects.toThrow("coverage exceeds 30 pages");
  });
});

it("reads Forgejo watches through provider policy rather than GitHub's probe", async () => {
  const { provider, paths } = harness();
  const snapshot = await provider.watchSnapshot!(ref);
  expect(snapshot).toMatchObject({ head: "head", checks: "pending", failed: [], requiredChecks: true });
  expect(snapshot.advisoryFailed).toMatchObject([{ name: "lint" }]);
  expect(paths).toContain("/api/v1/repos/acme/repo/issues/1/comments?limit=50&page=1");
  expect(paths).toContain("/api/v1/repos/acme/repo/pulls/1/reviews?limit=50&page=1");
});

it("does not stop remark pagination at a server-capped short page", async () => {
  const { provider, paths } = harness({ remarks: true });
  const snapshot = await provider.watchSnapshot!(ref);
  expect(snapshot.comments).toHaveLength(64);
  expect(paths).toContain("/api/v1/repos/acme/repo/issues/1/comments?limit=50&page=3");
});
