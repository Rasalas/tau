import type { ClientStorage, WorkbenchActions } from "tau";

/**
 * The local pull request: a branch against its base before any request
 * exists, with the pictures its turns left (turn attachments) — what both
 * halves share. No React and no host code here.
 */
export const LOCAL_PULL_REQUEST_TAB = "review.local-pull-request";

/**
 * Lent to other packages: puts pictures (turn attachments) into the local pull
 * request's description draft of the checkout on screen and opens it; `false`
 * when no project is open. Evidence Kit's viewer calls it.
 */
export const REVIEW_ATTACH_SERVICE = "tau.review/attach-evidence";

export interface ReviewAttachService {
  attach(media: readonly EvidenceMedia[], actions: Pick<WorkbenchActions, "openStageTab">): boolean;
}

/** One turn attachment of a thread, as `local-pr-evidence` answers it. */
export interface LocalEvidence {
  threadId: string;
  /** The extension that provided it. */
  source: string;
  id: string;
  turnId: string;
  turnStartedAt: number;
  turnEndedAt?: number;
  at: number;
  mediaType: string;
  size: number;
  width: number;
  height: number;
  caption: string;
}

/** A picture named for the description or an upload. */
export interface EvidenceMedia {
  threadId: string;
  source: string;
  id: string;
  caption: string;
}

/** Where pictures go when a request is created or commented on, or why they stay. */
export type UploadPlan =
  | { kind: "gitlab-uploads" | "github-ref"; destination: string }
  | { kind: "none"; reason: string };

export interface LocalCommit {
  sha: string;
  subject: string;
  body: string;
  at: number;
  author?: string;
}

/** `local-pr`: the branch against its base, commits newest first. */
export interface LocalBranch {
  root: string;
  branch?: string;
  base: string;
  remote?: string;
  commits: LocalCommit[];
  forkedAt?: number;
  diffStat?: string;
}

export interface EvidenceTurn {
  threadId: string;
  turnId: string;
  startedAt: number;
  endedAt?: number;
  frames: LocalEvidence[];
}

/** The turns whose work a commit took in; without `commit`, work not committed yet. */
export interface EvidenceGroup {
  commit?: LocalCommit;
  turns: EvidenceTurn[];
}

export const evidenceKey = (media: Pick<EvidenceMedia, "threadId" | "source" | "id">): string => `${media.threadId}\n${media.source}\n${media.id}`;

/** A caption as Markdown alt text: one line, no brackets. */
export const altText = (caption: string): string => caption.replace(/[[\]()\r\n]+/gu, " ").replace(/\s+/gu, " ").trim() || "Screenshot";

const SCHEME = "tau-evidence://";
const SCREENSHOTS_HEADING = "## Screenshots";
const TOKEN = /!\[([^\]\n]*)\]\(tau-evidence:\/\/([^/\s)]+)\/([^/\s)]+)\/([^/\s)]+)\)/gu;

/** The line a picture stands for in a description until it is uploaded. */
export function evidenceToken(media: EvidenceMedia): string {
  return `![${altText(media.caption)}](${SCHEME}${encodeURIComponent(media.threadId)}/${encodeURIComponent(media.source)}/${encodeURIComponent(media.id)})`;
}

const decode = (value: string): string | undefined => {
  try { return decodeURIComponent(value); } catch { return undefined; }
};

/** The pictures a description names, once each, in order. */
export function findEvidenceTokens(body: string): EvidenceMedia[] {
  const seen = new Set<string>();
  const found: EvidenceMedia[] = [];
  for (const match of body.matchAll(TOKEN)) {
    const [threadId, source, id] = [decode(match[2]!), decode(match[3]!), decode(match[4]!)];
    if (!threadId || !source || !id) continue;
    const media = { threadId, source, id, caption: match[1]!.trim() };
    if (seen.has(evidenceKey(media))) continue;
    seen.add(evidenceKey(media));
    found.push(media);
  }
  return found;
}

/**
 * Puts what `replace` answers where each picture stands; `undefined` takes the
 * picture out, with its line when it stood alone, and the Screenshots heading
 * when nothing is left under it.
 */
export function replaceEvidenceTokens(body: string, replace: (media: EvidenceMedia) => string | undefined): string {
  const replaced = body.replace(TOKEN, (whole, caption: string, thread: string, source: string, id: string) => {
    const [threadId, from, key] = [decode(thread), decode(source), decode(id)];
    if (!threadId || !from || !key) return whole;
    return replace({ threadId, source: from, id: key, caption: caption.trim() }) ?? "\u0000";
  });
  if (!replaced.includes("\u0000")) return replaced;
  const lines = replaced.split("\n").flatMap((line) => {
    if (!line.includes("\u0000")) return [line];
    const rest = line.replaceAll("\u0000", "");
    return rest.trim() ? [rest] : [];
  });
  const kept = lines.filter((line, index) => {
    if (line.trim() !== SCREENSHOTS_HEADING) return true;
    const next = lines.slice(index + 1).find((candidate) => candidate.trim());
    return next !== undefined && !/^#{1,6}\s/u.test(next);
  });
  return kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export type BodySegment = { kind: "text"; text: string } | { kind: "media"; media: EvidenceMedia };

/** The description as text and the pictures between it, for a preview. */
export function splitBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let last = 0;
  for (const match of body.matchAll(TOKEN)) {
    const [threadId, source, id] = [decode(match[2]!), decode(match[3]!), decode(match[4]!)];
    if (!threadId || !source || !id) continue;
    const before = body.slice(last, match.index);
    if (before.trim()) segments.push({ kind: "text", text: before });
    segments.push({ kind: "media", media: { threadId, source, id, caption: match[1]!.trim() } });
    last = match.index + match[0].length;
  }
  const rest = body.slice(last);
  if (rest.trim()) segments.push({ kind: "text", text: rest });
  return segments;
}

/** Adds pictures at the end under a heading of their own, or into it when it is there. */
export function insertEvidence(body: string, media: readonly EvidenceMedia[], heading = SCREENSHOTS_HEADING): string {
  const present = new Set(findEvidenceTokens(body).map(evidenceKey));
  const lines = media.filter((entry) => !present.has(evidenceKey(entry))).map(evidenceToken);
  if (lines.length === 0) return body;
  const trimmed = body.trimEnd();
  if (trimmed.split("\n").some((line) => line.trim() === heading)) return `${trimmed}\n${lines.join("\n")}\n`;
  return `${trimmed ? `${trimmed}\n\n` : ""}${heading}\n\n${lines.join("\n")}\n`;
}

/**
 * Which commit took in each turn's work: the first commit made at or after
 * the turn ended. A turn after the last commit is not committed yet; one that
 * ended before the branch left its base belongs to earlier work and is left
 * out. Commit times have whole seconds, so a commit in the same second counts.
 */
export function assignEvidence(commits: readonly LocalCommit[], evidence: readonly LocalEvidence[], forkedAt?: number): EvidenceGroup[] {
  const turns = new Map<string, EvidenceTurn>();
  for (const frame of evidence) {
    const key = `${frame.threadId}\n${frame.turnId}`;
    const turn = turns.get(key) ?? { threadId: frame.threadId, turnId: frame.turnId, startedAt: frame.turnStartedAt, ...(frame.turnEndedAt === undefined ? {} : { endedAt: frame.turnEndedAt }), frames: [] };
    turn.frames.push(frame);
    turns.set(key, turn);
  }
  const ascending = [...commits].sort((left, right) => left.at - right.at);
  const groups = new Map<string, EvidenceGroup>();
  const ended = (turn: EvidenceTurn) => turn.endedAt ?? Math.max(...turn.frames.map((frame) => frame.at));
  for (const turn of [...turns.values()].sort((left, right) => ended(left) - ended(right))) {
    turn.frames.sort((left, right) => left.at - right.at);
    const end = ended(turn);
    if (forkedAt !== undefined && end < forkedAt) continue;
    const commit = ascending.find((candidate) => candidate.at + 999 >= end);
    const key = commit?.sha ?? "";
    const group = groups.get(key) ?? { ...(commit ? { commit } : {}), turns: [] };
    group.turns.push(turn);
    groups.set(key, group);
  }
  // Newest first, like the commits: work not committed yet on top.
  return [...groups.values()].sort((left, right) => (right.commit?.at ?? Number.POSITIVE_INFINITY) - (left.commit?.at ?? Number.POSITIVE_INFINITY));
}

/** What the local view keeps for a branch between visits: the text being written and the pictures chosen. */
export interface LocalDraft {
  title: string;
  body: string;
  base: string;
  draft: boolean;
  selected: string[];
  updatedAt: number;
}

const DRAFTS_KEY = "tau.review.local-pull-request.drafts";
const MAX_DRAFTS = 50;

/** The drafts per checkout and branch, in client storage; the oldest go past fifty. */
export class LocalDrafts {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: () => ClientStorage | undefined, private readonly now: () => number = Date.now) {}

  /** Hears a draft changed from outside the view, as Evidence Kit's "Attach to review" does. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Chooses pictures for a branch's description, keeping what the draft holds. */
  attach(root: string, branch: string | undefined, keys: readonly string[]): void {
    const kept = this.get(root, branch);
    const { updatedAt: _updatedAt, ...draft } = kept ?? { title: "", body: "", base: "", draft: false, selected: [], updatedAt: 0 };
    this.set(root, branch, { ...draft, selected: [...new Set([...draft.selected, ...keys])] });
    for (const listener of [...this.listeners]) listener();
  }

  private read(): Record<string, LocalDraft> {
    try {
      const parsed = JSON.parse(this.storage()?.get(DRAFTS_KEY) ?? "{}") as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, LocalDraft> : {};
    } catch {
      return {};
    }
  }

  get(root: string, branch: string | undefined): LocalDraft | undefined {
    const entry = this.read()[`${root}\n${branch ?? ""}`];
    if (!entry || typeof entry.body !== "string" || typeof entry.title !== "string") return undefined;
    return { ...entry, selected: Array.isArray(entry.selected) ? entry.selected.filter((key) => typeof key === "string") : [] };
  }

  set(root: string, branch: string | undefined, draft: Omit<LocalDraft, "updatedAt">): void {
    const all = { ...this.read(), [`${root}\n${branch ?? ""}`]: { ...draft, updatedAt: this.now() } };
    const kept = Object.entries(all).sort(([, left], [, right]) => right.updatedAt - left.updatedAt).slice(0, MAX_DRAFTS);
    this.storage()?.set(DRAFTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  }

  clear(root: string, branch: string | undefined): void {
    const all = this.read();
    delete all[`${root}\n${branch ?? ""}`];
    this.storage()?.set(DRAFTS_KEY, JSON.stringify(all));
  }
}
