import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { ProviderTools, RepositoryTarget, SourceControlProvider } from "./provider.js";
import { altText, evidenceKey, findEvidenceTokens, replaceEvidenceTokens, type EvidenceMedia, type UploadPlan } from "./local-request.js";

/** A picture's bytes, as a turn attachment's `read` answers them. */
export interface MediaBytes {
  mediaType: string;
  /** Base64. */
  data: string;
}

export type ReadMedia = (media: EvidenceMedia) => Promise<MediaBytes | undefined>;

/** Reads a picture back from the extension that provided it, through `services.turnAttachments`. */
export function attachmentReader(context: HostExtensionContext): ReadMedia {
  return async (media) => context.services.turnAttachments?.read(media.threadId, media.source, media.id);
}

/** Pictures in one upload at most; a description with more is refused before anything is sent. */
export const MAX_UPLOAD = 30;
const REF_PREFIX = "refs/tau/evidence/";

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const slug = (value: string, max: number): string => value.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/\.{2,}/gu, ".").replace(/^[-.]+|[-.]+$/gu, "").slice(0, max) || "picture";
const extension = (mediaType: string): string => mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : mediaType === "image/gif" ? "gif" : mediaType === "video/webm" ? "webm" : "jpg";

/** The ref a branch's pictures live under on GitHub: outside heads and tags, so no branch list, no CI run. */
export function evidenceRef(branch: string | undefined): string {
  const name = (branch ?? "detached").replace(/[^A-Za-z0-9._/-]+/gu, "-").replace(/\/{2,}/gu, "/").replace(/\.{2,}/gu, ".")
    .split("/").map((part) => part.replace(/^\.+/u, "").replace(/\.lock$/u, "")).filter(Boolean).join("/").slice(0, 120);
  return `${REF_PREFIX}${name || "detached"}`;
}

/**
 * Where a repository's pictures can go. GitLab has an uploads API. GitHub has
 * none for descriptions: a public repository gets them as files on a ref of
 * its own, linked by commit; a private one keeps them on this machine, since
 * whether a signed-in reader sees such a link there is untested. Every other
 * host keeps them here too.
 */
export async function planUpload(provider: SourceControlProvider, target: RepositoryTarget, tools: ProviderTools, branch?: string): Promise<UploadPlan> {
  const where = target.host && target.repo ? `${target.host}/${target.repo}` : undefined;
  if (!where) return { kind: "none", reason: "Tau could not tell which repository the remote names." };
  if (provider.kind === "gitlab") return { kind: "gitlab-uploads", destination: `the uploads of ${where}` };
  if (provider.kind !== "github") return { kind: "none", reason: `${provider.info.name} offers Tau no upload for a description.` };
  const raw = record(JSON.parse(await tools.cli("github", { args: ["api", "--hostname", target.host, `repos/${target.repo}`] }, "Reading the repository", { host: target.host })));
  const visibility = text(raw.visibility) ?? (raw.private === false ? "public" : "private");
  if (visibility !== "public") {
    return { kind: "none", reason: `GitHub has no upload API for pull requests, and ${where} is ${visibility}: pictures kept in it might not show to its readers.` };
  }
  return { kind: "github-ref", destination: `${evidenceRef(branch)} in ${where}` };
}

/**
 * Uploads the pictures by the plan and answers the Markdown for each, keyed by
 * `evidenceKey`. Nothing is sent for a plan of `none`, and nothing at all when
 * one picture cannot be read.
 */
export async function uploadMedia(input: {
  plan: UploadPlan;
  target: RepositoryTarget;
  branch?: string;
  media: readonly EvidenceMedia[];
  read: ReadMedia;
  tools: ProviderTools;
  now?: () => number;
}): Promise<Map<string, string>> {
  const { plan, target, media, tools } = input;
  if (plan.kind === "none" || media.length === 0) return new Map();
  if (media.length > MAX_UPLOAD) throw new HostCommandError(`Choose ${MAX_UPLOAD} pictures at most; ${media.length} are in the description.`);
  const files: Array<{ media: EvidenceMedia; bytes: MediaBytes; name: string }> = [];
  for (const [index, entry] of media.entries()) {
    const bytes = await input.read(entry);
    if (!bytes) throw new HostCommandError(`The picture “${altText(entry.caption)}” is gone from this machine; take it out of the description.`);
    files.push({ media: entry, bytes, name: `${String(index + 1).padStart(2, "0")}-${slug(entry.caption, 40)}.${extension(bytes.mediaType)}` });
  }
  const links = plan.kind === "gitlab-uploads"
    ? await uploadToGitLab(target, files, tools)
    : await uploadToGitHubRef(target, input.branch, files, tools, input.now ?? Date.now);
  tools.log("evidence.uploaded", `${files.length} to ${plan.destination}`);
  return new Map(files.map((file, index) => [evidenceKey(file.media), `![${altText(file.media.caption)}](${links[index]!})`]));
}

async function uploadToGitLab(target: RepositoryTarget, files: ReadonlyArray<{ bytes: MediaBytes; name: string }>, tools: ProviderTools): Promise<string[]> {
  const folder = await mkdtemp(join(tmpdir(), "tau-evidence-"));
  try {
    const urls: string[] = [];
    for (const file of files) {
      const path = join(folder, file.name);
      await writeFile(path, Buffer.from(file.bytes.data, "base64"), { mode: 0o600 });
      const answer = record(JSON.parse(await tools.cli("gitlab", {
        args: ["api", "--hostname", target.host, "--method", "POST", `projects/${encodeURIComponent(target.repo)}/uploads`, "--form", `file=@${path}`],
      }, "Uploading a picture", { host: target.host })));
      const url = text(answer.url) ?? text(answer.full_path);
      if (!url) throw new HostCommandError("GitLab answered the upload without a link.");
      urls.push(url);
    }
    return urls;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * Blobs, a tree on top of the ref's last one, a commit and the ref moved
 * forward — through the Git data API, so the checkout is never touched and
 * earlier links keep their commit reachable.
 */
async function uploadToGitHubRef(target: RepositoryTarget, branch: string | undefined, files: ReadonlyArray<{ bytes: MediaBytes; name: string }>, tools: ProviderTools, now: () => number): Promise<string[]> {
  const repo = `repos/${target.repo}`;
  const api = async (path: string, action: string, body?: unknown, method = "POST"): Promise<Record<string, unknown>> => {
    const args = ["api", "--hostname", target.host, ...(body === undefined ? [] : ["--method", method, "--input", "-"]), path];
    const output = await tools.cli("github", { args, ...(body === undefined ? {} : { input: JSON.stringify(body) }) }, action, { host: target.host });
    const parsed = JSON.parse(output || "{}") as unknown;
    return Array.isArray(parsed) ? { list: parsed } : record(parsed);
  };
  const ref = evidenceRef(branch);
  const existing = ((await api(`${repo}/git/matching-refs/${ref.slice("refs/".length)}`, "Reading the pictures' ref")).list as unknown[] | undefined ?? [])
    .map(record).find((entry) => entry.ref === ref);
  const parent = text(record(existing?.object).sha);
  const parentTree = parent ? text(record((await api(`${repo}/git/commits/${parent}`, "Reading the pictures' ref")).tree).sha) : undefined;
  const stamp = new Date(now()).toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "").replace("T", "-");
  const entries = [];
  for (const file of files) {
    const blob = text((await api(`${repo}/git/blobs`, "Uploading a picture", { content: file.bytes.data, encoding: "base64" })).sha);
    if (!blob) throw new HostCommandError("GitHub answered the upload without a blob.");
    entries.push({ path: `${stamp}/${file.name}`, mode: "100644", type: "blob", sha: blob });
  }
  const tree = text((await api(`${repo}/git/trees`, "Uploading the pictures", { ...(parentTree ? { base_tree: parentTree } : {}), tree: entries })).sha);
  if (!tree) throw new HostCommandError("GitHub answered the upload without a tree.");
  const commit = text((await api(`${repo}/git/commits`, "Uploading the pictures", { message: `Pictures for ${branch ?? "a pull request"}`, tree, parents: parent ? [parent] : [] })).sha);
  if (!commit) throw new HostCommandError("GitHub answered the upload without a commit.");
  if (parent) await api(`${repo}/git/refs/${ref.slice("refs/".length)}`, "Moving the pictures' ref", { sha: commit, force: false }, "PATCH");
  else await api(`${repo}/git/refs`, "Creating the pictures' ref", { ref, sha: commit });
  // github.com serves these to a signed-in reader and does not proxy them.
  return entries.map((entry) => `https://${target.host}/${target.repo}/raw/${commit}/${entry.path.split("/").map(encodeURIComponent).join("/")}`);
}

/**
 * A description with its pictures uploaded and linked, or taken out where the
 * plan keeps them on this machine. Without pictures nothing is asked.
 */
export async function embedMedia(input: {
  provider: SourceControlProvider;
  target: RepositoryTarget;
  branch?: string;
  body: string;
  read: ReadMedia;
  tools: ProviderTools;
  now?: () => number;
}): Promise<{ body: string; uploaded: number; kept: number; plan?: UploadPlan }> {
  const media = findEvidenceTokens(input.body);
  if (media.length === 0) return { body: input.body, uploaded: 0, kept: 0 };
  const plan = await planUpload(input.provider, input.target, input.tools, input.branch);
  const links = await uploadMedia({ ...input, plan, media });
  return { body: replaceEvidenceTokens(input.body, (entry) => links.get(evidenceKey(entry))), uploaded: links.size, kept: media.length - links.size, plan };
}
