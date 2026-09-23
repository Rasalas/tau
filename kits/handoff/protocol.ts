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

export interface LineageState {
  links: LineageLink[];
}

export const EMPTY_LINEAGE: LineageState = { links: [] };

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
