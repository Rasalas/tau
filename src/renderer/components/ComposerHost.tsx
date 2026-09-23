import { Component, createRef, useEffect, useState, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";

function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The run's own line; it names no runtime, since the thread may run on any of them. */
export function LiveStatus({ startedAt, label }: { startedAt?: number; label?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const text = label ?? (startedAt ? `Working for ${elapsedLabel(Math.max(0, now - startedAt))}` : "Working…");
  return <div className="live-status"><span className="spinner" /><span>{text}</span></div>;
}

/** Why the thread's last turn failed, at the end of that turn, until the next prompt. */
export function TurnErrorLine({ message }: { message: string }) {
  return <div className="turn-error-line" role="status"><CircleAlert size={14} aria-hidden="true" /><span>{message}</span></div>;
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
