import { Component, createRef, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function LiveStatus({ startedAt, label = "Pi is working" }: { startedAt?: number; label?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <div className="live-status"><span className="spinner" /><span>{label}{startedAt ? ` · ${elapsedLabel(now - startedAt)}` : ""}</span></div>;
}

export function measureComposerGeometry(host: HTMLElement): DOMRect {
  return host.querySelector<HTMLElement>("[data-composer-surface]")?.getBoundingClientRect()
    ?? host.getBoundingClientRect();
}

interface ComposerHostProps {
  start: boolean;
  children: ReactNode;
}

/** Keeps the editor mounted and animates its move between start and thread layouts. */
export class ComposerHost extends Component<ComposerHostProps, Record<string, never>, DOMRect | undefined> {
  private readonly hostRef = createRef<HTMLDivElement>();
  private previousRect: DOMRect | undefined;
  private frame: number | undefined;
  private cleanupTimer: number | undefined;

  componentDidMount(): void { this.previousRect = this.measure(); }
  getSnapshotBeforeUpdate(): DOMRect | undefined { return this.measure(); }

  componentDidUpdate(previousProps: ComposerHostProps, _previousState: Record<string, never>, beforeLayout?: DOMRect): void {
    const current = this.measure();
    const previous = beforeLayout ?? this.previousRect;
    this.previousRect = current;
    if (previousProps.start !== this.props.start) this.animate(previous, current);
  }

  componentWillUnmount(): void { this.clearAnimation(); }

  private measure(): DOMRect | undefined {
    const host = this.hostRef.current;
    return host ? measureComposerGeometry(host) : undefined;
  }

  private animate(previous: DOMRect | undefined, current: DOMRect | undefined): void {
    const node = this.hostRef.current;
    this.clearAnimation();
    if (!node || !previous || !current) return;
    const reduceMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    const deltaX = previous.left - current.left;
    const deltaY = previous.top - current.top;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
    node.style.transition = "none";
    node.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
    node.style.willChange = "transform";
    void node.offsetWidth;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = undefined;
      node.style.transition = "transform 220ms cubic-bezier(.2, .8, .2, 1)";
      node.style.transform = "translate3d(0, 0, 0)";
      this.cleanupTimer = window.setTimeout(() => {
        this.cleanupTimer = undefined;
        node.style.transition = "";
        node.style.transform = "";
        node.style.willChange = "";
      }, 240);
    });
  }

  private clearAnimation(): void {
    const node = this.hostRef.current;
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    if (this.cleanupTimer !== undefined) window.clearTimeout(this.cleanupTimer);
    this.frame = undefined;
    this.cleanupTimer = undefined;
    if (node) {
      node.style.transition = "";
      node.style.transform = "";
      node.style.willChange = "";
    }
  }

  render(): ReactNode {
    return <div ref={this.hostRef} className={`conversation-composer-host ${this.props.start ? "start" : "docked"}`}>{this.props.children}</div>;
  }
}

export function useTailScroll(
  ref: RefObject<HTMLDivElement | null>,
  updates: readonly unknown[],
  resetKey?: unknown,
  preserveScrollRefOrPosition?: RefObject<boolean | undefined> | boolean,
  preservePosition = false,
): void {
  const preserveScrollRef = typeof preserveScrollRefOrPosition === "object" ? preserveScrollRefOrPosition : undefined;
  const preservePositionValue = typeof preserveScrollRefOrPosition === "boolean" ? preserveScrollRefOrPosition : preservePosition;
  const pinnedRef = useRef(true);
  const frameRef = useRef<number | undefined>(undefined);
  const preservePositionRef = useRef(preservePositionValue);
  const skipTailAfterPreserveRef = useRef(false);
  preservePositionRef.current = preservePositionValue;
  const scheduleTail = () => {
    if (preserveScrollRef?.current) {
      pinnedRef.current = false;
      return;
    }
    if (preservePositionRef.current) {
      skipTailAfterPreserveRef.current = true;
      return;
    }
    if (skipTailAfterPreserveRef.current) {
      skipTailAfterPreserveRef.current = false;
      return;
    }
    if (!pinnedRef.current || frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      const node = ref.current;
      if (node && pinnedRef.current) node.scrollTop = node.scrollHeight;
    });
  };

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    pinnedRef.current = true;
    let pointerDown = false;
    let touchY: number | undefined;
    const nearTail = () => node.scrollHeight - node.scrollTop - node.clientHeight < 32;
    const onScroll = () => {
      if (nearTail()) pinnedRef.current = true;
      else if (pointerDown) pinnedRef.current = false;
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) pinnedRef.current = false; };
    const onPointerDown = () => { pointerDown = true; };
    const onPointerUp = () => { pointerDown = false; };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== undefined && nextY !== undefined && nextY > touchY) pinnedRef.current = false;
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pinnedRef.current = false;
      if (event.key === "End") pinnedRef.current = true;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => scheduleTail());
    observer?.observe(node.firstElementChild ?? node);
    scheduleTail();
    return () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("keydown", onKeyDown);
      observer?.disconnect();
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    };
  }, [ref, resetKey]);

  useEffect(() => {
    if (preserveScrollRef?.current) {
      pinnedRef.current = false;
      return;
    }
    if (preservePositionValue) {
      skipTailAfterPreserveRef.current = true;
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
      return;
    }
    scheduleTail();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...updates, preservePositionValue]);
}
