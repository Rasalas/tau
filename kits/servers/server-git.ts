import type { ServerFs } from "./server-fs.js";
import type { ServerGitCommit, ServerGitInfo } from "./view-protocol.js";

/*
 * The server's Git, read only. `--no-optional-locks` keeps `git status` from
 * refreshing the index, which would write `index.lock` on the server.
 */
export const SERVER_GIT_STATUS = "git --no-optional-locks status --porcelain=v1 --branch -z";
export const SERVER_GIT_LOG = "git --no-optional-locks log -n 20 --no-color --format=%H%x1f%an%x1f%ct%x1f%s%x1e";
const FILE_CAP = 50;

/** `## main...origin/main [ahead 1, behind 2]` and the entries after it. */
export function parseGitStatus(output: string): Omit<Extract<ServerGitInfo, { repository: true }>, "commits"> {
  const records = output.split("\0");
  const info: Omit<Extract<ServerGitInfo, { repository: true }>, "commits"> = { repository: true, changed: 0, files: [] };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    if (record.startsWith("## ")) {
      const head = /^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/u.exec(record);
      if (head) {
        if (!head[1]!.startsWith("HEAD (no branch)")) info.branch = head[1]!;
        if (head[2]) info.upstream = head[2];
        const ahead = /ahead (\d+)/u.exec(head[3] ?? "");
        const behind = /behind (\d+)/u.exec(head[3] ?? "");
        if (ahead) info.ahead = Number(ahead[1]);
        if (behind) info.behind = Number(behind[1]);
      }
      continue;
    }
    const code = record.slice(0, 2);
    info.changed += 1;
    if (info.files.length < FILE_CAP) info.files.push({ path: record.slice(3), code });
    // A rename or copy carries its old name as the next record.
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return info;
}

export function parseGitLog(output: string): ServerGitCommit[] {
  return output.split("\x1e").map((record) => record.replace(/^\s+/u, "")).filter(Boolean).map((record) => {
    const [sha = "", author, at, subject = ""] = record.split("\x1f");
    return { sha, subject, ...(author ? { author } : {}), ...(at && Number.isFinite(Number(at)) ? { at: Number(at) } : {}) };
  }).filter((commit) => /^[0-9a-f]{7,64}$/u.test(commit.sha));
}

/** What the server's Git says about `remotePath`, or why there is nothing to say. */
export async function readServerGit(fs: Pick<ServerFs, "exec">, hasGit: boolean, signal?: AbortSignal): Promise<ServerGitInfo> {
  if (!fs.exec) return { repository: false, reason: "The server runs no commands for Tau (file access only)." };
  if (!hasGit) return { repository: false, reason: "The server has no git." };
  const options = { cwd: "project" as const, timeoutMs: 20_000, maxOutputBytes: 256 * 1024, ...(signal ? { signal } : {}) };
  const status = await fs.exec(SERVER_GIT_STATUS, options);
  if (status.code !== 0) {
    const reason = /not a git repository/iu.test(status.stderr) ? "The folder on the server is no Git repository." : (status.stderr.trim().split("\n").at(-1) || `git exited with ${status.code}`);
    return { repository: false, reason };
  }
  const log = await fs.exec(SERVER_GIT_LOG, options);
  return { ...parseGitStatus(status.stdout), commits: log.code === 0 ? parseGitLog(log.stdout) : [] };
}
