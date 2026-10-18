import { execFile } from "node:child_process";

/** Fetch the requested commit, falling back to the provider's fork-aware ref. */
export type GuideFetch = (root: string, remote: string, sha: string, headRef: string) => Promise<void>;

export const createGuideFetch = (noteSubprocess: () => void): GuideFetch => async (root, remote, sha, headRef) => {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(sha) || !/^refs\/(?:(?:pull|merge-requests)\/[1-9]\d*\/head|heads\/.{1,1024})$/u.test(headRef)) throw new Error("The request did not report a valid head commit and fetch ref.");
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    noteSubprocess();
    execFile("git", args, { cwd: root, timeout: 5 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, out, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message)); else resolve(out.trim());
    });
  });
  if (headRef.startsWith("refs/heads/")) await run(["check-ref-format", headRef]);
  const fetch = (revision: string) => run(["fetch", "--quiet", "--no-tags", "--", remote, revision]);
  await fetch(sha).catch(() => fetch(headRef));
  if (await run(["rev-parse", "--verify", `${sha}^{commit}`]) !== sha.toLowerCase()) throw new Error("The requested head commit is unavailable. Refresh the request and try again.");
};
