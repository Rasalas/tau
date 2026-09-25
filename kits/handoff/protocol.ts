/** Handoff Kit: what both halves share. No imports. */

export const HANDOFF_EXTENSION_ID = "tau.handoff";
/** Pushed on every change to the links, with a `LineageState`. */
export const LINEAGE_EVENT = "lineage";

/** The block a fork's first prompt carries: the context handed over from its parent. */
export const HANDOFF_TAG = "handoff_context";
/** The block a parent receives when a fork or a sub-agent is brought back. */
export const MERGE_BACK_TAG = "merge_back_context";

/**
 * The runtimes whose threads Tau forks itself (their backend offers `fork`):
 * a fork that stays on one of them keeps its history natively and needs no
 * summary. Pi's today.
 */
export const NATIVE_FORK_RUNTIMES: readonly string[] = ["pi"];

/** How the context crossed into a fork. */
export type HandoffStrategy = "native" | "portable";

/** A fork this kit made: which thread it continues and on what. */
export interface LineageLink {
  threadId: string;
  parentThreadId: string;
  strategy: HandoffStrategy;
  sourceBackend: string;
  targetBackend: string;
  createdAt: number;
  /** When the fork was last brought back to its parent. */
  mergedAt?: number;
}

/**
 * A thread here that continues on another machine (H08): an ordinary thread
 * there, followed through Remote Work Kit's link. The thread here stays usable.
 */
export interface RemoteContinuation {
  /** The thread here it continues. */
  threadId: string;
  /** Remote Work Kit's link (`tau.remote-work/threads`). */
  link: string;
  /** That machine's host id, and its name when the thread went. */
  machine: string;
  machineName: string;
  strategy: HandoffStrategy;
  createdAt: number;
  /** When its work was last brought back into this thread. */
  broughtAt?: number;
}

export interface LineageState {
  links: LineageLink[];
  remotes?: RemoteContinuation[];
}

export const EMPTY_LINEAGE: LineageState = { links: [], remotes: [] };

/** Pushed with the machines a thread may continue on, a `ContinueTarget[]`, whenever they change. */
export const TARGETS_EVENT = "targets";

/** A runtime on another machine, as its readiness reads. */
export interface TargetRuntime {
  kind: string;
  label: string;
  ready: boolean;
  /** Why it is not ready, for the menu. */
  note?: string;
}

/** A machine this host's agents may work on with Full access, and what runs there. */
export interface ContinueTarget {
  /** That machine's host id. */
  id: string;
  name: string;
  /** Absent until it answered; its readiness is asked when it connects and when a menu opens. */
  runtimes?: TargetRuntime[];
  /** Why its readiness could not be read. */
  error?: string;
}

export interface ContinueOnInput {
  threadId: string;
  /** A machine's host id, or its name when unique. */
  machine: string;
  /** What that machine should do next: the composer's draft. Needed where the history does not go along. */
  prompt?: string;
}

export interface ContinueOnResult {
  link: string;
  machine: string;
  machineName: string;
  native: boolean;
}

/** What a machine answers when its thread is brought back to where it came from. */
export interface RemoteMergeBackResult {
  header: string;
  summary: string;
  /** The last message the summary covers there. */
  through: string;
}

/** Called on the machine the thread went to, through `services.machines.call`. */
export const REMOTE_MERGE_BACK_COMMAND = "remote-merge-back";

export interface CreateTransferInput {
  threadId: string;
  /** The runtime backend kind the fork runs on, an instance included (`codex@work`). */
  target: string;
}

export interface CreateTransferResult {
  transferId: string;
  /** The fork keeps its history natively: duplicate the thread instead of summarizing it. */
  native: boolean;
  sourceTitle: string;
}

export interface ResolveTransferResult {
  /** The handoff block, put before the fork's first prompt. */
  context: string;
}

export interface PrepareMergeBackResult {
  parentThreadId: string;
  /** The merge-back block for the parent's composer. */
  context: string;
  /** The last message the block covers; the next bring-back starts after it. */
  through: string;
}

/** The first line of a block names where it came from; the rest is the summary. */
export function splitBlock(body: string): { header: string; summary: string } {
  const text = body.trim();
  const end = text.indexOf("\n");
  if (end < 0) return { header: text, summary: "" };
  return { header: text.slice(0, end).trim(), summary: text.slice(end + 1).trim() };
}

export function formatBlock(tag: string, header: string, summary: string): string {
  return `<${tag}>\n${header.trim()}\n\n${summary.trim()}\n</${tag}>`;
}
