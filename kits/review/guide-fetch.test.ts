import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuideFetch } from "./guide-fetch.js";
import { createGitHubProvider } from "./provider-github.js";
import { createGitLabProvider } from "./provider-gitlab.js";
import { createForgejoProvider } from "./provider-forgejo.js";
import { parseRequestUrl } from "./pull-request-json.js";
import type { ProviderTools } from "./provider.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
const actualProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const roots: string[] = [];
const noteSubprocess = vi.fn();
const fetchGuideHead = createGuideFetch(noteSubprocess);
afterEach(async () => { vi.mocked(execFile).mockClear(); noteSubprocess.mockClear(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(headRef: string) {
  const root = await mkdtemp(join(tmpdir(), "tau-guide-fetch-")); roots.push(root);
  const source = join(root, "source"), remote = join(root, "remote.git"), local = join(root, "local");
  git(root, "init", "-q", "--initial-branch=main", source);
  git(source, "config", "user.email", "fixture@example.invalid");
  git(source, "config", "user.name", "Fixture");
  await writeFile(join(source, "a.txt"), "base\n"); git(source, "add", "."); git(source, "commit", "-qm", "base");
  git(root, "clone", "-q", "--bare", source, remote);
  git(root, "clone", "-q", remote, local);
  await writeFile(join(source, "a.txt"), "head\n"); git(source, "commit", "-qam", "head");
  const sha = git(source, "rev-parse", "HEAD");
  git(source, "push", "-q", remote, `HEAD:${headRef}`);
  return { root, source, remote, local, sha };
}
function refuseShaFetch(afterValidation = false) {
  if (afterValidation) vi.mocked(execFile).mockImplementationOnce(actualProcess.execFile);
  vi.mocked(execFile).mockImplementationOnce((...args) => {
    const callback = args.at(-1) as (error: Error, out: string, stderr: string) => void;
    callback(new Error("Server refuses fetching by object id"), "", "Server refuses fetching by object id");
    return undefined as never;
  });
}

describe("fetching the exact guide head", () => {
  it("fetches by commit without moving the checkout", async () => {
    const f = await fixture("refs/pull/42/head");
    const before = git(f.local, "rev-parse", "HEAD");
    await fetchGuideHead(f.local, "origin", f.sha, "refs/pull/42/head");
    expect(git(f.local, "rev-parse", `${f.sha}^{commit}`)).toBe(f.sha);
    expect(git(f.local, "rev-parse", "HEAD")).toBe(before);
    expect(noteSubprocess).toHaveBeenCalledTimes(2);
  });
  it.each([
    [createGitHubProvider, "https://github.com/example/project/pull/42", "refs/pull/42/head"],
    [createGitLabProvider, "https://gitlab.com/example/project/-/merge_requests/42", "refs/merge-requests/42/head"],
    [createForgejoProvider, "https://codeberg.org/example/project/pulls/42", "refs/pull/42/head"],
  ] as const)("uses the provider ref when the server refuses a SHA fetch: %s", async (create, url, headRef) => {
    const provider = create({} as ProviderTools);
    expect(provider.info.capabilities.guides).toBe(true);
    expect(provider.requestHeadRef!(parseRequestUrl(url)!)).toBe(headRef);
    const f = await fixture(headRef);
    refuseShaFetch();
    await fetchGuideHead(f.local, "origin", f.sha, headRef);
    expect(git(f.local, "rev-parse", `${f.sha}^{commit}`)).toBe(f.sha);
    expect(noteSubprocess).toHaveBeenCalledTimes(3);
  });
  it("refuses a moved fallback ref that no longer supplies the requested commit", async () => {
    const headRef = "refs/merge-requests/42/head";
    const f = await fixture(headRef);
    // Replace the head with unrelated history, so fetching it cannot bring the old commit.
    git(f.source, "checkout", "--orphan", "replacement");
    git(f.source, "commit", "-qm", "unrelated");
    git(f.source, "push", "-q", "--force", f.remote, `HEAD:${headRef}`);
    refuseShaFetch();
    await expect(fetchGuideHead(f.local, "origin", f.sha, headRef)).rejects.toThrow();
    expect(git(f.local, "rev-parse", "HEAD")).not.toBe(git(f.source, "rev-parse", "HEAD"));
  });
  it("validates and fetches the source branch from a separate fork remote", async () => {
    const headRef = "refs/heads/feat/output";
    const f = await fixture(headRef);
    refuseShaFetch(true);
    await fetchGuideHead(f.local, f.remote, f.sha, headRef);
    expect(git(f.local, "rev-parse", `${f.sha}^{commit}`)).toBe(f.sha);
    expect(noteSubprocess).toHaveBeenCalledTimes(4);
  });
  it.each(["refs/heads/../bad", "refs/heads/a.lock", "refs/heads/with space", "refs/heads/a@{b"])("rejects invalid source ref %s before fetching", async (headRef) => {
    const f = await fixture("refs/pull/42/head");
    await expect(fetchGuideHead(f.local, f.remote, f.sha, headRef)).rejects.toThrow();
    expect(vi.mocked(execFile).mock.calls.some((call) => call[1]?.[0] === "fetch")).toBe(false);
  });
  it("rejects missing or option-shaped commit/ref facts before starting Git", async () => {
    await expect(fetchGuideHead("/unused", "origin", "--all", "refs/pull/42/head")).rejects.toThrow("valid head");
    await expect(fetchGuideHead("/unused", "origin", "a".repeat(40), "--upload-pack=bad")).rejects.toThrow("valid head");
    expect(execFile).not.toHaveBeenCalled();
  });
});
