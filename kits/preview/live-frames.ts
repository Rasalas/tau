import { useEffect, useRef, useState, type RefObject } from "react";

/** One answer of a frame source: a picture, the same one as before, or nothing to show. */
export type LiveFrameAnswer =
  | { id: string; data: string; width: number; height: number; mimeType?: string }
  | { id: string; unchanged: true }
  | null;

/** Asks the host for the next frame at `maxWidth`; `since` is the one on screen. */
export type LiveFrameSource = (maxWidth: number, since: string | undefined) => Promise<LiveFrameAnswer>;

export interface LivePicture {
  id: string;
  url: string;
  width: number;
  height: number;
}

/** Fractions of the width a client would draw at; a slow link steps down, a fast one back up. */
export const FRAME_TIERS = [1, 0.75, 0.5, 0.35] as const;
export const FRAME_WIDTH = { min: 120, max: 1_600 } as const;
/** Between frames: quick while the user acts on the page, calm while they watch, calmer once they only watch. */
export const INTERVAL_MS = { interacting: 250, watching: 1_000, idle: 2_500 } as const;
/** How long after an input the view counts as interacting. */
export const INTERACTING_MS = 3_000;
/** After this long without an input, a page that keeps changing (a blinking caret, an animation) is fetched less often. */
export const IDLE_AFTER_MS = 15_000;
const SLOW_MS = 900;
const FAST_MS = 300;
const FAST_FRAMES_TO_STEP_UP = 3;

/** The width to ask for: what the element draws in device pixels (at most 2×), times the tier. */
export function frameWidth(cssWidth: number, devicePixelRatio: number, tier: number): number {
  const scale = FRAME_TIERS[Math.max(0, Math.min(FRAME_TIERS.length - 1, tier))]!;
  const wanted = Math.max(1, cssWidth) * Math.min(2, Math.max(1, devicePixelRatio || 1)) * scale;
  return Math.round(Math.min(FRAME_WIDTH.max, Math.max(FRAME_WIDTH.min, wanted)));
}

export interface PaceState {
  tier: number;
  fastFrames: number;
}

/**
 * After one answer: the tier for the next and how long to wait. A picture that
 * took long to arrive means the link is the limit, so the next is smaller and
 * waits at least as long again — the view never takes more than half the link.
 */
export function pace(state: PaceState, answer: { elapsedMs: number; picture: boolean; interacting: boolean; idle?: boolean; tiers?: number }): { state: PaceState; delayMs: number } {
  const tiers = answer.tiers ?? FRAME_TIERS.length;
  let { tier, fastFrames } = state;
  if (answer.picture && answer.elapsedMs > SLOW_MS) {
    tier = Math.min(tiers - 1, tier + 1);
    fastFrames = 0;
  } else if (answer.picture && answer.elapsedMs < FAST_MS) {
    fastFrames += 1;
    if (fastFrames >= FAST_FRAMES_TO_STEP_UP && tier > 0) {
      tier -= 1;
      fastFrames = 0;
    }
  } else if (answer.picture) {
    fastFrames = 0;
  }
  const base = answer.interacting ? INTERVAL_MS.interacting : answer.idle ? INTERVAL_MS.idle : INTERVAL_MS.watching;
  return { state: { tier, fastFrames }, delayMs: Math.max(base, answer.picture ? answer.elapsedMs : 0) };
}

/** Whether the element is on screen at all: a hidden tab, a closed sheet or a scrolled-away view asks for nothing. */
function useOnScreen(element: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [intersecting, setIntersecting] = useState(true);
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    const target = element.current;
    if (!target || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => setIntersecting(entries.some((entry) => entry.isIntersecting)));
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return visible && intersecting;
}

export interface LiveFrames {
  picture?: LivePicture;
  /** The link is slow and the picture smaller than the view. */
  reduced: boolean;
  /** Nothing is asked while the view is off screen. */
  paused: boolean;
  /** Call after an input: frames come quicker for a moment, and one comes now. */
  poke(): void;
}

/**
 * Frames of the page or window for a view on screen: one request at a time,
 * sized to the element and paced by the link, and none at all while the view
 * is hidden. Nothing is pushed: the host only answers what this view asks.
 */
export function useLiveFrames(source: LiveFrameSource | undefined, element: RefObject<HTMLElement | null>, options: { active: boolean } = { active: true }): LiveFrames {
  const onScreen = useOnScreen(element);
  const running = Boolean(source) && options.active && onScreen;
  const [picture, setPicture] = useState<LivePicture | undefined>();
  const [tier, setTier] = useState(0);
  // Opening the view counts as an input: the first seconds come at the watching pace.
  const interactedAt = useRef(Date.now());
  const wake = useRef<(() => void) | undefined>(undefined);

  useEffect(() => { setPicture(undefined); }, [source]);

  useEffect(() => {
    if (!running || !source) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let paceState: PaceState = { tier: 0, fastFrames: 0 };
    let since: string | undefined;
    const next = async () => {
      timer = undefined;
      wake.current = undefined;
      const width = element.current?.clientWidth ?? 390;
      const started = performance.now();
      let answer: LiveFrameAnswer = null;
      try {
        answer = await source(frameWidth(width, window.devicePixelRatio, paceState.tier), since);
      } catch {
        answer = null;
      }
      if (!live) return;
      const got = Boolean(answer && "data" in answer);
      if (answer && "data" in answer) {
        since = answer.id;
        setPicture({ id: answer.id, url: `data:${answer.mimeType ?? "image/jpeg"};base64,${answer.data}`, width: answer.width, height: answer.height });
      } else if (!answer) {
        since = undefined;
        setPicture(undefined);
      }
      const sinceInput = Date.now() - interactedAt.current;
      const paced = pace(paceState, { elapsedMs: performance.now() - started, picture: got, interacting: sinceInput < INTERACTING_MS, idle: sinceInput >= IDLE_AFTER_MS });
      paceState = paced.state;
      setTier(paceState.tier);
      timer = setTimeout(() => void next(), paced.delayMs);
      wake.current = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        void next();
      };
    };
    void next();
    return () => {
      live = false;
      wake.current = undefined;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [element, running, source]);

  return {
    ...(picture ? { picture } : {}),
    reduced: tier > 0,
    paused: !running,
    poke: () => {
      interactedAt.current = Date.now();
      wake.current?.();
    },
  };
}

/**
 * The same loop outside React, for another kit's small picture (a handover
 * card): frames at `maxWidth` while the page is visible, until the returned stop.
 */
export function watchFrames(source: LiveFrameSource, maxWidth: number, onFrame: (picture: LivePicture | undefined) => void): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let since: string | undefined;
  let paceState: PaceState = { tier: 0, fastFrames: 0 };
  const watchedSince = Date.now();
  const next = async () => {
    if (!live) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      timer = setTimeout(() => void next(), INTERVAL_MS.watching);
      return;
    }
    const started = Date.now();
    const answer = await source(Math.round(maxWidth * FRAME_TIERS[paceState.tier]!), since).catch(() => null);
    if (!live) return;
    if (answer && "data" in answer) {
      since = answer.id;
      onFrame({ id: answer.id, url: `data:${answer.mimeType ?? "image/jpeg"};base64,${answer.data}`, width: answer.width, height: answer.height });
    } else if (!answer) {
      since = undefined;
      onFrame(undefined);
    }
    const paced = pace(paceState, { elapsedMs: Date.now() - started, picture: Boolean(answer && "data" in answer), interacting: false, idle: Date.now() - watchedSince >= IDLE_AFTER_MS });
    paceState = paced.state;
    timer = setTimeout(() => void next(), paced.delayMs);
  };
  void next();
  return () => {
    live = false;
    if (timer !== undefined) clearTimeout(timer);
  };
}
