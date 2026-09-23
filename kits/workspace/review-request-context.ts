import { firstExistingRef, primaryRemote, resolveDefaultBaseRef, runGitCommand, type GitRunner } from "./workspace-git.js";
import type { ReviewRequestContext } from "./protocol.js";

const TEMPLATE_MAX_CHARS = 8_000;
const MAX_COMMITS = 50;
const MAX_DIFF_STAT_CHARS = 8_000;

const TEMPLATE_FILES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  ".gitlab/merge_request_templates/Default.md",
  // Forgejo and Gitea read their own folders first, Azure DevOps its own and `.vsts`.
  ".forgejo/pull_request_template.md",
  ".forgejo/PULL_REQUEST_TEMPLATE.md",
  ".gitea/pull_request_template.md",
  ".gitea/PULL_REQUEST_TEMPLATE.md",
  ".azuredevops/pull_request_template.md",
  ".vsts/pull_request_template.md",
];
const TEMPLATE_DIRECTORIES = [".github/PULL_REQUEST_TEMPLATE", "PULL_REQUEST_TEMPLATE", "docs/PULL_REQUEST_TEMPLATE", ".gitlab/merge_request_templates"];

/** `git ls-tree -z` records: `<mode> <type> <oid>\t<path>`; only regular blobs count. */
function templateBlobs(output: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    if (type === "blob" && (mode === "100644" || mode === "100755") && oid) blobs.set(record.slice(tab + 1), oid);
  }
  return blobs;
}

/**
 * The repository's pull or merge request template, read from the base tree's
 * committed blobs so a symlink in the worktree never reaches the host's files.
 * A directory with more than one template is ambiguous and yields none.
 */
export async function readRequestTemplate(cwd: string, treeish: string, runGit: GitRunner = runGitCommand): Promise<string | undefined> {
  const listing = await runGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", treeish, "--", ...TEMPLATE_FILES, ...TEMPLATE_DIRECTORIES]).catch(() => "");
  const blobs = templateBlobs(listing);
  const read = async (oid: string) => {
    const text = (await runGit(cwd, ["cat-file", "blob", oid]).catch(() => "")).trim();
    return text ? text.slice(0, TEMPLATE_MAX_CHARS) : undefined;
  };
  for (const path of TEMPLATE_FILES) {
    const oid = blobs.get(path);
    const text = oid ? await read(oid) : undefined;
    if (text) return text;
  }
  for (const directory of TEMPLATE_DIRECTORIES) {
    const candidates = [...blobs].filter(([path]) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/") && path.toLowerCase().endsWith(".md"));
    if (candidates.length === 1) return read(candidates[0]![1]);
  }
  return undefined;
}

/**
 * What opening a pull or merge request needs to know about a checkout: its
 * branch, the remote and upstream, and the base a new request merges into.
 * With `detail` it adds the commits since that base, a diff stat and the
 * repository's template, which is what a generated title and body read.
 */
export async function readReviewRequestContext(
  cwd: string,
  options: { detail?: boolean; base?: string } = {},
  runGit: GitRunner = runGitCommand,
): Promise<ReviewRequestContext> {
  const text = async (args: string[]) => (await runGit(cwd, args).catch(() => "")).trim();
  const root = (await text(["rev-parse", "--show-toplevel"])) || cwd;
  const branch = (await text(["branch", "--show-current"])) || undefined;
  const remoteName = await primaryRemote(cwd, runGit);
  const remoteUrl = remoteName ? await text(["remote", "get-url", remoteName]) : "";
  const upstream = (await text(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) || undefined;
  const ahead = upstream ? Number(await text(["rev-list", "--count", "@{u}..HEAD"])) || 0 : undefined;
  const defaultBase = options.base?.trim() || await resolveDefaultBaseRef(cwd, runGit);
  const base = remoteName && defaultBase.startsWith(`${remoteName}/`) ? defaultBase.slice(remoteName.length + 1) : defaultBase;
  const context: ReviewRequestContext = {
    root,
    ...(branch ? { branch } : {}),
    ...(remoteName ? { remote: { name: remoteName, url: remoteUrl } } : {}),
    ...(upstream ? { upstream, ahead } : {}),
    base,
  };
  if (!options.detail) return context;
  const baseRef = await firstExistingRef(cwd, remoteName ? [`${remoteName}/${base}`, base] : [base], runGit);
  const range = baseRef ? `${baseRef}..HEAD` : "HEAD";
  const log = await text(["log", "--no-merges", `--max-count=${MAX_COMMITS}`, "--format=%s%x1f%b%x1e", range]);
  const commits = log.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [subject = "", body = ""] = entry.split("\x1f");
    return { subject: subject.trim(), body: body.trim() };
  });
  const diffStat = baseRef ? (await text(["diff", "--stat=120", `${baseRef}...HEAD`])).slice(0, MAX_DIFF_STAT_CHARS) : "";
  const template = await readRequestTemplate(cwd, baseRef ?? "HEAD", runGit);
  return { ...context, commits, ...(diffStat ? { diffStat } : {}), ...(template ? { template } : {}) };
}
