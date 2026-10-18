/**
 * A review guide: a tour of one pull request for the person deciding whether
 * it lands (ADR 0034). Types and names shared by the host half that writes and
 * stores it and the desktop half that reads it. Pure data, no imports.
 */

/** The one call a reader should make at a stop; not a bug and not a nit. */
export type GuideAttentionKind = "tradeoff" | "contract" | "product" | "risk" | "accessibility";

export interface GuideAttention {
  kind: GuideAttentionKind;
  note: string;
}

/** Lines worth reading, always inside the change. `old` shows removed code. */
export interface GuideExcerpt {
  path: string;
  side: "new" | "old";
  start: number;
  end: number;
  caption: string;
}

/** An explanation anchored to one line inside one of the stop's excerpts. */
export interface GuideNote {
  path: string;
  line: number;
  title: string;
  body: string;
}

/** A changed file the stop owns without excerpting it. */
export interface GuideFileEntry {
  path: string;
  note?: string;
}

export interface GuideStop {
  title: string;
  summary: string;
  attention: GuideAttention | null;
  excerpts: GuideExcerpt[];
  files: GuideFileEntry[];
  notes: GuideNote[];
  questions: string[];
}

export interface PullRequestGuide {
  /** The head the guide was written against; another head makes it stale. */
  headSha: string;
  generatedAt: string;
  /** `provider/model-id` of the thread that wrote it, when known. */
  model: string | null;
  stops: GuideStop[];
}

/** A run in progress, or the last one that failed. Held in memory only. */
export type GuideRun =
  | { state: "running"; headSha: string; startedAt: string; threadId?: string }
  | { state: "failed"; headSha: string; failedAt: string; detail: string };

/** What a client or an agent learns about a pull request's guide. */
export interface GuideResult {
  guide: PullRequestGuide | null;
  run: GuideRun | null;
  /** Null where the host reported no head with the request. */
  currentHeadSha: string | null;
  /** The beta switch; off hides the tab and refuses runs for people and agents alike. */
  enabled: boolean;
}

export type GuideOutcome = "started" | "running" | "failed";

/** The answer to a request to write a guide; it never waits for the guide. */
export interface GuideWriteResult extends GuideResult {
  outcome: GuideOutcome;
  /** Why a run did not start. */
  detail?: string;
  /** The Agents-panel thread that is writing it. */
  threadId?: string;
}

/** Host commands of Review Kit for guides. */
export const GUIDE_GET_COMMAND = "guide-get";
export const GUIDE_WRITE_COMMAND = "guide-write";
/** Emitted whenever a guide or its run changes; clients read again. */
export const GUIDE_EVENT = "pr-guide-changed";

export interface GuideEvent {
  url: string;
  number: number;
  /** `ready` and `failed` end a run; `running` starts one. */
  kind: "running" | "ready" | "failed";
  title?: string;
  /** The thread the run was started from, for a push that opens it. */
  parentThreadId?: string;
}

/** Review Kit's settings for guides, as `services.settings` and the preferences store spell them. */
export const GUIDE_ENABLED_OPTION = "review-guides";
export const GUIDE_RUNTIME_VALUE = "review-guide-runtime";
export const GUIDE_MODEL_VALUE = "review-guide-model";
export const GUIDE_EFFORT_VALUE = "review-guide-effort";
export const GUIDE_INSTRUCTIONS_VALUE = "review-guide-instructions";

/** Tools only the guide agent sees. */
export const GUIDE_DIFF_TOOL = "read_pull_request_diff";
export const GUIDE_SUBMIT_TOOL = "submit_pull_request_guide";
/** The agent definition name the run uses; the agent's Agents-panel row carries it. */
export const GUIDE_AGENT = "pr-guide";

/** Stops a guide keeps, and the longest excerpt (the reader wants the idea, not the hunk). */
export const GUIDE_MAX_STOPS = 8;
export const GUIDE_MAX_EXCERPT_LINES = 25;
export const GUIDE_MAX_NOTES = 3;
export const GUIDE_MAX_QUESTIONS = 2;
/** Pull requests one `write_pull_request_guides` call may name. */
export const GUIDE_MAX_REQUESTS = 20;

/** The store key of a pull request: the same one for every thread, project and machine of this host. */
export function guideKey(ref: { host: string; repo: string; number: number }): string {
  return `${ref.host.toLowerCase()}/${ref.repo}#${ref.number}`;
}
