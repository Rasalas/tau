import type { HostExtensionClient } from "tau";
import type { PendingReviewStore } from "./pending-review.js";

/** What the detail view needs beside its review: the sidebar's store, held notes, and Workspace Kit's host for "Open in editor". */
export interface DetailParts {
  store: ReviewDetailStore;
  notes: PendingReviewStore;
  workspace: HostExtensionClient;
}

/** One file in the detail's sidebar: its change, and whether it is one of the conflicting files. */
export interface DetailFile {
  path: string;
  added: number;
  removed: number;
  conflict?: boolean;
}

/** A note collected on a diff line, kept until it is sent. */
export interface DetailNote {
  id: string;
  /** "Watcher.tsx:33" */
  label: string;
  text: string;
}

export interface DetailState {
  /** The review's key or the pull request's URL: the sidebar draws only the detail it belongs to. */
  key: string;
  kind: "local" | "remote";
  files: readonly DetailFile[];
  /** Files the page knows of but cannot list (a host that names only some). */
  moreFiles: number;
  /** A local review's turns, a remote one's commits. */
  turnsHeading: "Turns" | "Commits";
  turns: readonly string[];
  notes: readonly DetailNote[];
  /** The one button under the notes: "Send both as one turn", or "Submit review". */
  sendLabel: string;
  sendDisabled?: string;
  /** The file the page has at its top. */
  active?: string;
}

export interface DetailActions {
  jump(path: string): void;
  sendAll(): void;
  sendNote?(id: string): void;
  removeNote(id: string): void;
}

/**
 * What the open review tells its sidebar: the page and the sidebar are two
 * trees, so the page publishes here and the sidebar reads.
 */
export class ReviewDetailStore {
  private state: DetailState | undefined;
  private handlers: DetailActions | undefined;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): DetailState | undefined => this.state;

  actions = (): DetailActions | undefined => this.handlers;

  publish(state: DetailState, handlers: DetailActions): void {
    this.state = state;
    this.handlers = handlers;
    this.emit();
  }

  /** The detail closed: its sidebar goes, unless another detail already took its place. */
  retire(key: string): void {
    if (this.state?.key !== key) return;
    this.state = undefined;
    this.handlers = undefined;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
