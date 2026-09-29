import type { ClientStorage } from "tau";
import type { PendingReviewComment } from "./protocol.js";

const KEY = "tau.review.pending-reviews";
const EMPTY: readonly PendingReviewComment[] = [];

function decode(raw: string | undefined): Map<string, PendingReviewComment[]> {
  const reviews = new Map<string, PendingReviewComment[]>();
  try {
    for (const [url, comments] of Object.entries(JSON.parse(raw ?? "{}") as Record<string, unknown>)) {
      const kept = (Array.isArray(comments) ? comments : []).filter((comment): comment is PendingReviewComment => {
        const value = comment as Partial<PendingReviewComment> | null;
        return Boolean(value && typeof value.id === "string" && typeof value.path === "string" && typeof value.line === "number" && typeof value.body === "string" && (value.side === "new" || value.side === "old"));
      });
      if (kept.length > 0) reviews.set(url, kept);
    }
  } catch {
    // A store it cannot read holds no review.
  }
  return reviews;
}

/**
 * Line comments held for a review not yet submitted, per request, in this
 * client's storage: they outlive the tab and a restart, and
 * go to the host only with the review.
 */
export class PendingReviewStore {
  private reviews: Map<string, PendingReviewComment[]>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: () => ClientStorage | undefined, private readonly id: () => string = () => crypto.randomUUID()) {
    this.reviews = decode(storage()?.get(KEY) ?? undefined);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  comments(url: string): readonly PendingReviewComment[] {
    return this.reviews.get(url) ?? EMPTY;
  }

  add(url: string, comment: Omit<PendingReviewComment, "id">): void {
    this.write(url, [...this.comments(url), { ...comment, id: this.id() }]);
  }

  remove(url: string, id: string): void {
    this.write(url, this.comments(url).filter((comment) => comment.id !== id));
  }

  clear(url: string): void {
    this.write(url, []);
  }

  private write(url: string, comments: PendingReviewComment[]): void {
    const next = new Map(this.reviews);
    if (comments.length > 0) next.set(url, comments); else next.delete(url);
    this.reviews = next;
    this.storage()?.set(KEY, JSON.stringify(Object.fromEntries(next)));
    for (const listener of [...this.listeners]) listener();
  }
}
