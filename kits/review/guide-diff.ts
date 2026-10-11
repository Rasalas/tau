import type { PullRequestCommit, PullRequestFiles } from "./protocol.js";

const LIMIT = 60_000;

/** The changed files with their counts and the request's commits: what `git diff --stat` and `git log` give a human. */
export function renderChangeList(files: Pick<PullRequestFiles, "files" | "diffs">, commits: readonly Pick<PullRequestCommit, "oid" | "headline">[]): string {
  const lines = files.files.map((file) => {
    const diff = files.diffs.find((entry) => entry.path === file.path);
    const note = !diff ? " (no diff available)" : diff.truncated ? " (diff cut)" : "";
    return `${file.status.padEnd(8)} +${file.added} -${file.removed}  ${file.path}${file.previousPath ? ` (from ${file.previousPath})` : ""}${note}`;
  });
  return [`${files.files.length} changed files:`, ...lines, "", `${commits.length} commits:`, ...commits.map((commit) => `${commit.oid.slice(0, 9)} ${commit.headline}`)].join("\n");
}

/** One file's diff with the line numbers an excerpt or a note must use: `new` for added and unchanged lines, `old` for removed. */
export function renderFileDiff(files: Pick<PullRequestFiles, "files" | "diffs">, path: string): string {
  const diff = files.diffs.find((entry) => entry.path === path);
  if (!diff) return files.files.some((file) => file.path === path) ? `${path} is changed, but the host gave no diff for it (binary or too large). List it in files.` : `${path} is not changed by this pull request.`;
  const out: string[] = [`${path}  +${diff.added} -${diff.removed}`];
  for (const hunk of diff.hunks) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      if (line.kind === "removed") out.push(`-  old ${String(line.oldLine ?? "").padStart(5)} | ${line.text}`);
      else out.push(`${line.kind === "added" ? "+" : " "} new ${String(line.newLine ?? "").padStart(5)} | ${line.text}`);
    }
  }
  const text = out.join("\n");
  const tail = diff.truncated ? "\n[the host cut this diff; later hunks are missing]" : "";
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n[cut at ${LIMIT} characters; read the file for the rest]` : text + tail;
}
