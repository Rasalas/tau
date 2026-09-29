import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bot, CircleAlert, CircleDollarSign, Clock, FileDiff, GitBranch, Hourglass, MessageCircleQuestion, PlugZap, CircleCheck, LoaderCircle, Archive } from "lucide-react";
import {
  MiddleTruncate,
  ProjectIcon,
  ProviderIconStack,
  providerStackLabel,
  threadCostLabel,
  threadCostOrigin,
  THREAD_QUESTION_LABEL,
  useModelName,
  type ThreadActivity,
  type UiSession,
  type WorkbenchActions,
} from "tau";
import type { ThreadCardRowProps, ThreadCardSection, TurnStat } from "./protocol.js";
import { diffStatLabel } from "./rail-details.js";

/** A pointer resting this long on a row opens its card; one sweeping over the rail opens nothing. */
export const THREAD_CARD_OPEN_DELAY_MS = 180;
/** Leaving waits this long, so the pointer can cross from the row to its card. */
export const THREAD_CARD_CLOSE_DELAY_MS = 220;

export interface CardTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const windowTimers: CardTimers = {
  set: (run, ms) => window.setTimeout(run, ms),
  clear: (handle) => window.clearTimeout(handle as number),
};

/**
 * Which row's card is open, from where the pointer and the keyboard are. A
 * rest on a row opens it, moving to another row switches after the same rest,
 * and leaving row and card closes it after a short grace. Keyboard focus opens
 * at once; a press on the row closes it until the pointer leaves that row.
 */
export class ThreadCardHover {
  private shown: string | undefined;
  private timer: unknown;
  private pressed: string | undefined;
  private byFocus = false;

  constructor(private readonly changed: (key: string | undefined) => void, private readonly timers: CardTimers = windowTimers) {}

  current(): string | undefined {
    return this.shown;
  }

  enterRow(key: string): void {
    if (key === this.pressed) return;
    this.pressed = undefined;
    this.byFocus = false;
    if (key === this.shown) { this.cancel(); return; }
    this.schedule(key, THREAD_CARD_OPEN_DELAY_MS);
  }

  leaveRow(key: string): void {
    if (key === this.pressed) this.pressed = undefined;
    this.leave();
  }

  enterCard(): void {
    this.cancel();
  }

  /** The pointer left the list; a row pressed and then moved away from under it is forgotten too. */
  leaveList(): void {
    this.pressed = undefined;
    this.leave();
  }

  leave(): void {
    if (this.shown === undefined) { this.cancel(); return; }
    this.schedule(undefined, THREAD_CARD_CLOSE_DELAY_MS);
  }

  focusRow(key: string): void {
    this.cancel();
    this.byFocus = true;
    this.set(key);
  }

  /** Focus left the row: closes a card the keyboard opened, not one the pointer holds. */
  blurRow(): void {
    if (this.byFocus) this.close();
  }

  press(key: string): void {
    this.pressed = key;
    this.close();
  }

  close(): void {
    this.cancel();
    this.set(undefined);
  }

  dispose(): void {
    this.cancel();
  }

  private schedule(key: string | undefined, ms: number): void {
    this.cancel();
    this.timer = this.timers.set(() => { this.timer = undefined; this.set(key); }, ms);
  }

  private cancel(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private set(key: string | undefined): void {
    if (key === undefined) this.byFocus = false;
    if (key === this.shown) return;
    this.shown = key;
    this.changed(key);
  }
}

/** The row wrappers the rail draws carry one of these; the card is keyed by its value. */
const ROW_SELECTOR = "[data-rail-thread], [data-rail-external]";
const CARD_ID = "rail-thread-card";

function rowOf(target: EventTarget | null): HTMLElement | undefined {
  return target instanceof Element ? target.closest<HTMLElement>(ROW_SELECTOR) ?? undefined : undefined;
}

function keyOf(row: HTMLElement): string {
  return row.dataset.railThread ?? row.dataset.railExternal ?? "";
}

export interface ThreadCardTarget {
  key: string;
  /** The rail section the row sits in, for a thread the rail lists more than once. */
  section?: string;
}

/**
 * One hover card for every row under `root`, the way the tooltip layer works:
 * listeners on the list, not a component per row. `render` draws the card for
 * a row; it answers nothing for a row it no longer knows, which closes it.
 */
export function ThreadCardLayer({ root, render, timers }: {
  root: RefObject<HTMLElement | null>;
  render(target: ThreadCardTarget, close: () => void): ReactNode;
  timers?: CardTimers;
}) {
  const [target, setTarget] = useState<ThreadCardTarget>();
  const rowRef = useRef<HTMLElement | undefined>(undefined);
  const hover = useRef<ThreadCardHover | undefined>(undefined);
  if (!hover.current) {
    hover.current = new ThreadCardHover((key) => {
      const row = key ? [...(root.current?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? [])].find((element) => keyOf(element) === key) : undefined;
      rowRef.current = row;
      setTarget(row ? { key: keyOf(row), ...(row.dataset.railSection ? { section: row.dataset.railSection } : {}) } : undefined);
    }, timers);
  }
  const controller = hover.current;

  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    let keyboard = false;
    const onKey = (event: KeyboardEvent) => {
      keyboard = true;
      if (event.key !== "Escape" || controller.current() === undefined) return;
      controller.close();
      // Inside the rail the key only closes the card; elsewhere it still does what it does there.
      if (element.contains(document.activeElement)) { event.preventDefault(); event.stopPropagation(); }
    };
    const onAnyDown = () => { keyboard = false; };
    const onDown = (event: PointerEvent) => {
      const row = rowOf(event.target);
      if (row) controller.press(keyOf(row));
    };
    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const row = rowOf(event.target);
      if (row) controller.enterRow(keyOf(row));
    };
    const onOut = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (!element.contains(event.relatedTarget as Node | null)) { controller.leaveList(); return; }
      const row = rowOf(event.target);
      if (!row || row.contains(event.relatedTarget as Node | null)) return;
      controller.leaveRow(keyOf(row));
    };
    const onFocusIn = (event: FocusEvent) => {
      const row = rowOf(event.target);
      if (row && keyboard) controller.focusRow(keyOf(row));
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (rowOf(next) && rowOf(next) === rowOf(event.target)) return;
      if (next && document.getElementById(CARD_ID)?.contains(next)) return;
      if (rowOf(event.target)) controller.blurRow();
    };
    const onScroll = () => controller.close();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onAnyDown, true);
    element.addEventListener("pointerdown", onDown, true);
    element.addEventListener("pointerover", onOver);
    element.addEventListener("pointerout", onOut);
    element.addEventListener("focusin", onFocusIn);
    element.addEventListener("focusout", onFocusOut);
    element.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onAnyDown, true);
      element.removeEventListener("pointerdown", onDown, true);
      element.removeEventListener("pointerover", onOver);
      element.removeEventListener("pointerout", onOut);
      element.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("focusout", onFocusOut);
      element.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onScroll);
      controller.dispose();
    };
  }, [controller, root]);

  const close = () => controller.close();
  const content = target && rowRef.current?.isConnected ? render(target, close) : null;

  const open = Boolean(content);
  // The row's button names the card while it is open.
  useEffect(() => {
    const button = rowRef.current?.querySelector<HTMLElement>(".thread-main");
    if (!open || !button || button.hasAttribute("aria-describedby")) return undefined;
    button.setAttribute("aria-describedby", CARD_ID);
    return () => { if (button.getAttribute("aria-describedby") === CARD_ID) button.removeAttribute("aria-describedby"); };
  }, [open, target]);

  if (!content || !rowRef.current) return null;
  return <PlacedCard anchor={rowRef.current} controller={controller}>{content}</PlacedCard>;
}

/** Beside the row, to the right of the rail, its top at the row's and kept inside the window. */
export function cardPlacement(anchor: { top: number; right: number }, size: { width: number; height: number }, viewport: { width: number; height: number }, gap = 6, padding = 8): { left: number; top: number } {
  const clamp = (value: number, min: number, max: number) => max < min ? min : Math.min(Math.max(value, min), max);
  return {
    left: Math.round(clamp(anchor.right + gap, padding, viewport.width - padding - size.width)),
    top: Math.round(clamp(anchor.top, padding, viewport.height - padding - size.height)),
  };
}

function PlacedCard({ anchor, controller, children }: { anchor: HTMLElement; controller: ThreadCardHover; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const rect = anchor.getBoundingClientRect();
    const placed = cardPlacement({ top: rect.top, right: rect.right }, element.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
    element.style.left = `${placed.left}px`;
    element.style.top = `${placed.top}px`;
  });
  return createPortal(
    <div
      ref={card}
      id={CARD_ID}
      className="thread-card"
      role="dialog"
      aria-label="Thread details"
      onPointerEnter={() => controller.enterCard()}
      onPointerLeave={() => controller.leave()}
    >
      {children}
    </div>,
    document.body,
  );
}

const CloseCard = createContext<() => void>(() => undefined);

/** A line of the card: its icon, then text cut short on one line. */
export function ThreadCardRow({ icon, children, tone, onClick, label }: ThreadCardRowProps) {
  const close = useContext(CloseCard);
  const className = `thread-card-row${tone ? ` tone-${tone}` : ""}`;
  const body = <><span className="thread-card-icon" aria-hidden="true">{icon}</span><span className="thread-card-text">{children}</span></>;
  return onClick
    ? <button type="button" className={className} aria-label={label} onClick={() => { close(); onClick(); }}>{body}</button>
    : <div className={className} {...(label ? { role: "group", "aria-label": label } : {})}>{body}</div>;
}

export interface ThreadCardProps {
  session: UiSession;
  activity: ThreadActivity;
  activityLabel?: string;
  activityHint?: string;
  age: string;
  projectIcon?: string;
  /** Another machine's thread: its name and mark, and why it cannot open now. */
  machine?: { name: string; icon: ReactNode };
  unavailable?: string;
  /** How many threads this one spawned, and how many of them work now. */
  agents?: { total: number; working: number };
  stat?: TurnStat;
  showCost: boolean;
  sections: readonly ThreadCardSection[];
  actions: WorkbenchActions;
  onClose(): void;
}

type CardRow = { order: number; key: string; node: ReactNode };

function statusRow(activity: ThreadActivity, label: string | undefined, hint: string | undefined, age: string): { icon: ReactNode; text: string; tone?: ThreadCardRowProps["tone"] } {
  const text = label && hint ? `${label}: ${hint}` : label ?? "";
  switch (activity) {
    case "working":
    case "tool": return { icon: <LoaderCircle size={12} />, text: text || "Working", tone: "working" };
    case "waiting": return { icon: <MessageCircleQuestion size={12} />, text: text || THREAD_QUESTION_LABEL, tone: "warning" };
    case "failed": return { icon: <CircleAlert size={12} />, text, tone: "danger" };
    case "limited": return { icon: <Hourglass size={12} />, text, tone: "warning" };
    case "interrupted":
    case "stalled": return { icon: <PlugZap size={12} />, text: text || "Interrupted", tone: "warning" };
    case "ready": return { icon: <CircleCheck size={12} />, text: "Finished while you were away" };
    case "settled": return { icon: <Archive size={12} />, text: `Settled · updated ${updatedLabel(age)}` };
    default: return { icon: <Clock size={12} />, text: `Updated ${updatedLabel(age)}` };
  }
}

function updatedLabel(age: string): string {
  return age === "now" ? "just now" : /^\d+[mhd]$/u.test(age) ? `${age} ago` : `on ${age}`;
}

function agentsLabel({ total, working }: { total: number; working: number }): string {
  const noun = (count: number) => `${count} agent${count === 1 ? "" : "s"}`;
  if (working > 0 && working >= total) return `${noun(working)} running`;
  return working > 0 ? `${noun(total)}, ${working} running` : noun(total);
}

/**
 * The thread card: the whole title, then a line per fact the rail knows
 * with its icon, then what other kits add. Only what is there is drawn.
 */
export function ThreadCard(props: ThreadCardProps) {
  const { session, projectIcon, machine, unavailable, agents, stat, showCost, sections, actions } = props;
  const runtime = session.backendKind ?? "pi";
  const modelName = useModelName(runtime, session.model, session.modelProvider);
  const route = providerStackLabel(session.modelProvider, runtime);
  const cost = showCost ? threadCostLabel(session.usage) : undefined;
  const status = statusRow(props.activity, props.activityLabel, props.activityHint, props.age);
  const external = Boolean(machine);
  const rows: CardRow[] = [
    {
      // The rail row's own mark, so the card's reads the same.
      order: 10, key: "project", node: <ThreadCardRow icon={<ProjectIcon project={{ path: session.projectPath, name: session.projectName, workspaceId: session.workspaceId }} icon={projectIcon} />}>{session.projectName}</ThreadCardRow>,
    },
  ];
  if (machine) rows.push({ order: 20, key: "machine", node: <ThreadCardRow icon={machine.icon}>{machine.name}</ThreadCardRow> });
  if (session.projectLabel) rows.push({ order: 30, key: "branch", node: <ThreadCardRow icon={<GitBranch size={12} />}><MiddleTruncate value={session.projectLabel} /></ThreadCardRow> });
  if (session.modelProvider || session.model || session.backendKind) {
    rows.push({
      order: 40, key: "model", node: <ThreadCardRow icon={<ProviderIconStack modelProvider={session.modelProvider} runtimeProvider={runtime} hint={false} />}>
        {modelName ?? session.model ?? route}{modelName || session.model ? <span className="thread-card-muted"> · {route}</span> : null}
      </ThreadCardRow>,
    });
  }
  if (status.text) rows.push({ order: 50, key: "status", node: <ThreadCardRow icon={status.icon} {...(status.tone ? { tone: status.tone } : {})}>{status.text}</ThreadCardRow> });
  if (stat) rows.push({ order: 55, key: "changes", node: <ThreadCardRow icon={<FileDiff size={12} />}>Last turn {diffStatLabel(stat)} in {stat.files} file{stat.files === 1 ? "" : "s"}</ThreadCardRow> });
  if (agents && agents.total + agents.working > 0) rows.push({ order: 60, key: "agents", node: <ThreadCardRow icon={<Bot size={12} />}>{agentsLabel(agents)}</ThreadCardRow> });
  if (cost && session.usage) {
    rows.push({ order: 70, key: "cost", node: <ThreadCardRow icon={<CircleDollarSign size={12} />}>{cost}<span className="thread-card-muted"> · {threadCostOrigin(session.usage).split(" · ")[0]}</span></ThreadCardRow> });
  }
  if (unavailable) rows.push({ order: 90, key: "unavailable", node: <ThreadCardRow icon={<CircleAlert size={12} />} tone="warning">{unavailable}</ThreadCardRow> });
  const contributed = sections.filter((section) => section.place === "row");
  contributed.forEach((section, index) => rows.push({
    order: section.order ?? 80,
    key: `row-${index}`,
    node: <section.Component session={session} external={external} actions={actions} Row={ThreadCardRow} />,
  }));
  rows.sort((left, right) => left.order - right.order);
  const blocks = sections.filter((section) => section.place === "section").sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

  return (
    <CloseCard.Provider value={props.onClose}>
      <strong className="thread-card-title">{session.title}</strong>
      <div className="thread-card-rows">{rows.map((row) => <Fragment key={row.key}>{row.node}</Fragment>)}</div>
      {blocks.map((section, index) => (
        <div key={index} className="thread-card-section">
          <section.Component session={session} external={external} actions={actions} Row={ThreadCardRow} />
        </div>
      ))}
    </CloseCard.Provider>
  );
}
