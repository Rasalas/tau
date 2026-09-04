import type { UiMessage } from "../../shared/contracts";
import {
  followTail,
  stopFollowing,
  type ScrollIntent,
  type TranscriptMessageLookup,
  type TranscriptNavigationState,
} from "./transcript-navigation";

/**
 * Framework-free owner of every transcript scroll write. One controller per
 * transcript: one rAF in flight, one ResizeObserver, one intent timer.
 */

/** What the transcript does on its own when content or size changes. */
export type TranscriptScrollMode = "tail" | "anchored" | "free";

/** Minimal scroll surface so unit tests can drive a plain fake element. */
export interface ScrollSurface {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

const TAIL_SLACK_PX = 32;
const INTENT_TIMEOUT_MS = 120;
const ANCHOR_TOLERANCE_PX = 0.5;
const SEEK_ATTEMPT_LIMIT = 8;
const OLDER_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const NEWER_KEYS = new Set(["ArrowDown", "PageDown"]);

export function transcriptScrollMode(state: TranscriptNavigationState): TranscriptScrollMode {
  if (!state.following) return "free";
  return state.anchorPending || state.anchorLocked ? "anchored" : "tail";
}

export function maxScrollTop(node: ScrollSurface): number {
  return Math.max(0, node.scrollHeight - node.clientHeight);
}

export function hasScrollOverflow(node: ScrollSurface): boolean {
  return node.scrollHeight > node.clientHeight + 1;
}

export function setScrollTopClamped(node: ScrollSurface, target: number): void {
  node.scrollTop = Math.max(0, Math.min(maxScrollTop(node), target));
}

export function scrollToTail(node: ScrollSurface): void {
  // The browser clamps scrollHeight to the real maximum; the explicit value
  // also keeps the preview fixture deterministic.
  node.scrollTop = node.scrollHeight;
}

export function elementPaddingTop(node: HTMLElement): number {
  const value = Number.parseFloat(window.getComputedStyle(node).paddingTop);
  return Number.isFinite(value) ? value : 0;
}

/** Offset of `element` inside the scrolled content of `node`. */
export function contentTop(node: HTMLElement, element: HTMLElement): number {
  const nodeRect = node.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  // Real layout has useful rects, including the virtual row's transform. The
  // offset fallback keeps the transition deterministic before first paint.
  if (elementRect.height > 0 || elementRect.top !== 0 || nodeRect.top !== 0) {
    return node.scrollTop + elementRect.top - nodeRect.top;
  }
  const transform = element.style.transform.match(/translateY\(\s*(-?\d+(?:\.\d+)?)px\s*\)/u);
  if (transform?.[1] !== undefined) return Number(transform[1]);
  let top = 0;
  let current: HTMLElement | null = element;
  while (current && current !== node) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return top;
}

/** Distance from the viewport top, or undefined before first layout. */
export function viewportTop(node: HTMLElement, element: HTMLElement): number | undefined {
  const nodeRect = node.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  if (elementRect.height > 0 || elementRect.top !== 0 || nodeRect.top !== 0) {
    return elementRect.top - nodeRect.top;
  }
  return undefined;
}

export function findMessageElement(node: ParentNode, messageId: string): HTMLElement | undefined {
  return [...node.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((element) => element.dataset.messageId === messageId);
}

export function transcriptRows(node: ParentNode): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(".virtual-transcript-row")];
}

/** A single rAF slot. Chained frames replace the slot instead of adding one. */
export class FrameLoop {
  private handle: number | undefined;

  get pending(): boolean { return this.handle !== undefined; }

  schedule(run: () => void): void {
    if (this.handle !== undefined) return;
    this.handle = requestAnimationFrame(() => {
      this.handle = undefined;
      run();
    });
  }

  /** Two frames: the first lets batched measurement land, the second reads it. */
  scheduleAfterLayout(run: () => void): void {
    if (this.handle !== undefined) return;
    this.handle = requestAnimationFrame(() => {
      this.handle = requestAnimationFrame(() => {
        this.handle = undefined;
        run();
      });
    });
  }

  cancel(): void {
    if (this.handle !== undefined) cancelAnimationFrame(this.handle);
    this.handle = undefined;
  }
}

/**
 * Short-lived hint about which direction the user asked for. A raw scroll event
 * carries no cause, so gestures arm an intent that expires on its own.
 */
export class ScrollIntentTracker {
  intent: ScrollIntent | undefined;
  private timer: number | undefined;
  private generation = 0;

  arm(intent: ScrollIntent): void {
    this.clear();
    const generation = this.generation;
    this.intent = intent;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      if (this.generation === generation && this.intent === intent) this.intent = undefined;
    }, INTENT_TIMEOUT_MS);
  }

  clear(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.intent = undefined;
    this.timer = undefined;
    this.generation += 1;
  }

  get armed(): boolean { return this.timer !== undefined || this.intent !== undefined; }
}

export interface TranscriptScrollDeps {
  getNode(): HTMLDivElement | null;
  getMessages(): readonly UiMessage[];
  getLookup(): TranscriptMessageLookup | undefined;
  onAnchorChange(id?: string): void;
  onJumpAvailabilityChange(canJump: boolean): void;
}

export class TranscriptScrollController {
  // One frame slot for the whole controller: tail/anchor placement and turn
  // seeking are mutually exclusive modes, so they never compete for it.
  private readonly frames = new FrameLoop();
  private readonly intent = new ScrollIntentTracker();
  private readonly scrollListeners = new Set<() => void>();
  private seekTarget: { messageId: string; attempts: number } | undefined;
  private observer: ResizeObserver | undefined;
  private attached: HTMLDivElement | undefined;

  constructor(
    private readonly state: TranscriptNavigationState,
    private readonly deps: TranscriptScrollDeps,
  ) {}

  get mode(): TranscriptScrollMode { return transcriptScrollMode(this.state); }

  /** Extra scroll consumers reuse the controller's single listener. */
  subscribeScroll(listener: () => void): () => void {
    this.scrollListeners.add(listener);
    return () => { this.scrollListeners.delete(listener); };
  }

  attach(node: HTMLDivElement): void {
    if (this.attached === node) return;
    this.detach();
    this.attached = node;
    this.state.lastScrollTop = node.scrollTop;
    node.addEventListener("scroll", this.onScroll, { passive: true });
    node.addEventListener("wheel", this.onWheel, { passive: true });
    node.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    node.addEventListener("touchstart", this.onTouchStart, { passive: true });
    node.addEventListener("touchmove", this.onTouchMove, { passive: true });
    node.addEventListener("touchend", this.onTouchEnd, { passive: true });
    node.addEventListener("touchcancel", this.onTouchEnd, { passive: true });
    node.addEventListener("keydown", this.onKeyDown);
    // A drag can release outside the transcript, and the composer keeps focus
    // while End/PageUp still mean transcript navigation.
    window.addEventListener("pointerup", this.onPointerUp, { passive: true });
    window.addEventListener("pointercancel", this.onPointerUp, { passive: true });
    window.addEventListener("keydown", this.onWindowKeyDown);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.sync());
      this.observer.observe(node);
      this.observer.observe(node.firstElementChild ?? node);
    }
  }

  detach(): void {
    const node = this.attached;
    this.attached = undefined;
    if (node) {
      node.removeEventListener("scroll", this.onScroll);
      node.removeEventListener("wheel", this.onWheel);
      node.removeEventListener("pointerdown", this.onPointerDown);
      node.removeEventListener("touchstart", this.onTouchStart);
      node.removeEventListener("touchmove", this.onTouchMove);
      node.removeEventListener("touchend", this.onTouchEnd);
      node.removeEventListener("touchcancel", this.onTouchEnd);
      node.removeEventListener("keydown", this.onKeyDown);
    }
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("keydown", this.onWindowKeyDown);
    this.observer?.disconnect();
    this.observer = undefined;
    this.intent.clear();
    this.cancelSeek();
  }

  /** Ask for one placement pass in the current mode. */
  sync(): void {
    if (!this.state.following || this.frames.pending) return;
    this.frames.schedule(() => {
      const node = this.deps.getNode();
      if (!node || !this.state.following) return;
      if (this.state.anchorPending) {
        if (this.placeAnchor(node)) this.state.anchorPending = false;
      } else if (this.state.anchorLocked) {
        this.preserveAnchor(node);
      } else {
        scrollToTail(node);
      }
      this.updateJumpAvailability(node);
    });
  }

  refreshJumpAvailability(): void {
    const node = this.deps.getNode();
    if (node) this.updateJumpAvailability(node);
  }

  /** Forget the previous offset so the next scroll event is not a direction. */
  resetScrollBaseline(): void {
    const node = this.deps.getNode();
    if (node) this.state.lastScrollTop = node.scrollTop;
  }

  resetIntent(): void {
    this.intent.clear();
    this.cancelSeek();
  }

  jumpToLatest(): void {
    const node = this.deps.getNode();
    if (!node) return;
    this.cancelSeek();
    followTail(this.state, this.deps.onAnchorChange);
    this.deps.onJumpAvailabilityChange(false);
    if (typeof node.scrollTo !== "function") {
      scrollToTail(node);
      this.sync();
      return;
    }
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    this.frames.schedule(() => {
      const current = this.deps.getNode();
      if (current && this.state.following) current.scrollTo({ top: current.scrollHeight, behavior: "smooth" });
    });
  }

  jumpToMessage(messageId: string): void {
    const node = this.deps.getNode();
    if (!node || !this.deps.getMessages().some((message) => message.id === messageId)) return;

    // A turn selection is an explicit reading decision. Release the tail
    // lease before moving so streaming deltas cannot pull the user back down.
    stopFollowing(this.state, this.deps.onAnchorChange);
    this.cancelSeek();
    this.seekTarget = { messageId, attempts: 0 };
    this.seekStep();
    this.updateJumpAvailability(node);
  }

  private seekStep = (): void => {
    const target = this.seekTarget;
    const node = this.deps.getNode();
    if (!target || !node || this.state.following) return;
    if (this.placeMessage(node, target.messageId) || target.attempts >= SEEK_ATTEMPT_LIMIT) {
      this.seekTarget = undefined;
      this.updateJumpAvailability(node);
      return;
    }
    target.attempts += 1;
    this.frames.schedule(this.seekStep);
  };

  private cancelSeek(): void {
    this.seekTarget = undefined;
    this.frames.cancel();
  }

  private updateJumpAvailability(node: HTMLDivElement): void {
    this.deps.onJumpAvailabilityChange(!this.state.following && hasScrollOverflow(node));
  }

  private anchorElement(node: HTMLDivElement): HTMLElement | undefined {
    const id = this.state.anchorId;
    return id ? findMessageElement(node, id) : undefined;
  }

  private indexOfMessage(messageId: string): number {
    return this.deps.getLookup()?.positions.get(messageId)
      ?? this.deps.getMessages().findIndex((message) => message.id === messageId);
  }

  /** Seek to an estimated offset so the virtualizer mounts the wanted window. */
  private seekEstimated(node: HTMLDivElement, messageId: string, minimumRowHeight = 0): boolean {
    const count = this.deps.getMessages().length;
    const index = this.indexOfMessage(messageId);
    const estimatedRowHeight = count > 0 ? Math.max(minimumRowHeight, node.scrollHeight / count) : 0;
    if (index < 0 || estimatedRowHeight <= 0) return false;
    setScrollTopClamped(node, index * estimatedRowHeight - elementPaddingTop(node));
    return true;
  }

  private placeMessage(node: HTMLDivElement, messageId: string): boolean {
    const message = findMessageElement(node, messageId);
    if (!message) {
      // TanStack Virtual may not have mounted a distant row yet. Seeking to
      // its estimated position mounts the relevant window; a later frame then
      // uses the real row geometry without inventing transcript content.
      this.seekEstimated(node, messageId, 1);
      return false;
    }
    setScrollTopClamped(node, contentTop(node, message) - elementPaddingTop(node));
    return true;
  }

  private placeAnchor(node: HTMLDivElement): boolean {
    const anchor = this.anchorElement(node);
    if (!anchor) {
      // The estimate is derived from the real virtualizer height, so it never
      // creates a synthetic spacer for a short transcript.
      const anchorId = this.state.anchorId;
      if (!anchorId || !this.seekEstimated(node, anchorId)) scrollToTail(node);
      return false;
    }
    const target = Math.max(0, contentTop(node, anchor) - elementPaddingTop(node));
    const limit = maxScrollTop(node);
    if (target > limit) {
      // There is not enough content below the prompt yet. Keep the natural
      // tail; this deliberately does not manufacture a spacer.
      node.scrollTop = limit;
      return false;
    }
    node.scrollTop = target;
    this.state.anchorLocked = true;
    return true;
  }

  private preserveAnchor(node: HTMLDivElement): void {
    const anchor = this.anchorElement(node);
    if (!anchor) return;
    const currentTop = viewportTop(node, anchor);
    if (currentTop === undefined) return;
    const delta = currentTop - elementPaddingTop(node);
    if (Math.abs(delta) < ANCHOR_TOLERANCE_PX) return;
    setScrollTopClamped(node, node.scrollTop + delta);
  }

  private nearTail(node: HTMLDivElement): boolean {
    return node.scrollHeight - node.scrollTop - node.clientHeight < TAIL_SLACK_PX;
  }

  private onScroll = (): void => {
    const node = this.attached;
    if (!node) return;
    const previous = this.state.lastScrollTop;
    const next = node.scrollTop;
    this.state.lastScrollTop = next;
    const direction = previous === undefined || next === previous
      ? undefined
      : next < previous ? "older" : "newer";
    const userIntent = this.state.pointerDown || this.state.touchActive || this.intent.intent !== undefined;
    // A direction observed in the actual scroll event outranks a stale wheel
    // hint. This prevents a delayed downward timer from reviving following
    // after the user has already moved upward.
    const olderIntent = direction === "older" || (direction === undefined && this.intent.intent === "older");
    const newerIntent = direction === "newer" || (direction === undefined && this.intent.intent === "newer");
    if (userIntent && olderIntent) {
      stopFollowing(this.state, this.deps.onAnchorChange);
    } else if (userIntent && this.nearTail(node) && newerIntent && !olderIntent) {
      followTail(this.state, this.deps.onAnchorChange);
      this.sync();
    }
    // A seek performed by placeAnchor changes the virtualizer's window. Ask
    // for one precise placement after that window has mounted, while any
    // genuine upward intent above has already disabled following.
    if (this.state.following && this.state.anchorPending && this.state.anchorId) this.sync();
    if (this.intent.armed) this.intent.clear();
    this.updateJumpAvailability(node);
    for (const listener of this.scrollListeners) listener();
  };

  private onWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0) {
      stopFollowing(this.state, this.deps.onAnchorChange);
      this.intent.arm("older");
      this.refreshJumpAvailability();
    } else if (event.deltaY > 0) {
      this.intent.arm("newer");
    }
  };

  private onPointerDown = (): void => { this.state.pointerDown = true; };
  private onPointerUp = (): void => { this.state.pointerDown = false; };

  private onTouchStart = (event: TouchEvent): void => {
    this.state.touchActive = true;
    this.state.lastTouchY = event.touches[0]?.clientY;
    if (this.attached) this.state.lastScrollTop = this.attached.scrollTop;
  };

  private onTouchMove = (event: TouchEvent): void => {
    const nextY = event.touches[0]?.clientY;
    const previousY = this.state.lastTouchY;
    const direction = previousY === undefined || nextY === undefined
      ? undefined
      : nextY > previousY ? "older" : nextY < previousY ? "newer" : undefined;
    if (direction === "older") {
      stopFollowing(this.state, this.deps.onAnchorChange);
      this.intent.arm("older");
    } else if (direction) {
      this.intent.arm(direction);
    }
    this.state.lastTouchY = nextY;
    this.onScroll();
  };

  private onTouchEnd = (): void => {
    this.state.touchActive = false;
    this.state.lastTouchY = undefined;
    this.intent.clear();
  };

  private applyNavigationKey(key: string): boolean {
    if (OLDER_KEYS.has(key)) {
      stopFollowing(this.state, this.deps.onAnchorChange);
      return true;
    }
    if (NEWER_KEYS.has(key)) {
      this.intent.arm("newer");
      return true;
    }
    if (key !== "End") return false;
    followTail(this.state, this.deps.onAnchorChange);
    this.sync();
    return true;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    this.applyNavigationKey(event.key);
    this.refreshJumpAvailability();
  };

  // Composer and window focus still count as an intentional navigation choice.
  // Do not cancel the browser's default textarea behavior here.
  private onWindowKeyDown = (event: KeyboardEvent): void => {
    if (this.applyNavigationKey(event.key)) this.refreshJumpAvailability();
  };
}
