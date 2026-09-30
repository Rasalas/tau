import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChartColumn } from "lucide-react";
import { ProviderIconStack, tooltipProps, useThreadStore, type PageSummaryProps } from "tau";
import { juicebarGroups, type Juicebar, type JuicebarChoices, type JuicebarGroup } from "./juicebars.js";
import { providerMark, stateText } from "./limits.js";
import type { LimitsFeed } from "./limits-feed.js";
import { USAGE_PAGE } from "./protocol.js";
import { steadyPercent } from "./quota.js";
import { resetsIn } from "./view-model.js";

const OPEN_DELAY_MS = 180;
const CLOSE_DELAY_MS = 220;
const CARD_WIDTH = 300;

export function tone(entry: JuicebarGroup): CSSProperties {
  return { "--usage-tone": `var(--provider-${entry.tone})` } as CSSProperties;
}

export function titleOf(entry: JuicebarGroup): string {
  return entry.group.members.length > 1 ? entry.group.label.split(" · ")[0]! : entry.group.label;
}

/** What one bar says, as the page's window line does. */
function barText(bar: Juicebar, now: number): { value: string; reset?: string; status?: ReturnType<typeof stateText> } {
  const expired = bar.state.kind === "expired";
  const reset = expired ? "Reset reached" : resetsIn(bar.window, now);
  return { value: expired ? "—" : `${bar.left}% left`, ...(reset ? { reset } : {}), status: stateText(bar.state, bar.window, now) };
}

function CardWindow({ bar, now }: { bar: Juicebar; now: number }) {
  const { value, reset, status } = barText(bar, now);
  const steady = bar.state.kind === "expired" ? undefined : steadyPercent(bar.window, now);
  return (
    <div className="usage-juicecard-window" data-level={bar.level}>
      <p><span>{bar.window.label}</span><b>{value}</b></p>
      <span className="usage-juicecard-track">
        {bar.left > 0 ? <i style={{ width: `${bar.left}%` }} /> : null}
        {steady === undefined ? null : <em style={{ left: `${100 - steady}%` }} />}
      </span>
      <p className="usage-juicecard-meta"><span>{reset}</span>{status ? <span data-level={status.level}>{status.label}</span> : null}</p>
    </div>
  );
}

/** Juicebar's details popover: every account the bars stand for, each bar's window, what is left, the reset and the pace. */
function JuiceCard({ groups, now, anchor, onEnter, onLeave }: { groups: JuicebarGroup[]; now: number; anchor: DOMRect; onEnter(): void; onLeave(): void }) {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8));
  return createPortal(
    <div className="usage-juicecard" role="tooltip" id="usage-juicecard" style={{ left, bottom: window.innerHeight - anchor.top + 8, width: CARD_WIDTH }} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      {groups.map((entry) => {
        const account = entry.group.shown;
        const stale = entry.bars.every((bar) => bar.level === "stale");
        return (
          <section key={entry.group.key} style={tone(entry)}>
            <header>
              <ProviderIconStack {...providerMark(entry.group)} hint={false} />
              <strong>{titleOf(entry)}</strong>
              {account.plan ? <small>{account.plan}</small> : null}
              {stale ? <em>Last known reading</em> : null}
            </header>
            {entry.bars.map((bar) => <CardWindow key={bar.window.id} bar={bar} now={now} />)}
          </section>
        );
      })}
      <footer>Click for Usage. Each plan there chooses its bars with Show in sidebar.</footer>
    </div>,
    document.body,
  );
}

/** Opens after a rest or on keyboard focus, stays while the pointer is on the card. */
function useCard() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const later = (next: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [open]);
  return {
    open,
    enter: () => later(true, OPEN_DELAY_MS),
    stay: () => clearTimeout(timer.current),
    leave: () => later(false, CLOSE_DELAY_MS),
    show: () => { clearTimeout(timer.current); setOpen(true); },
    hide: () => { clearTimeout(timer.current); setOpen(false); },
  };
}

/** Reads the limits again a moment after a run ends. */
export function useRunEnded(feed: LimitsFeed): void {
  const threads = useThreadStore();
  const running = useSyncExternalStore(threads.subscribeToActivity, () => threads.getActivity().runningThreadIds.length);
  const last = useRef(running);
  useEffect(() => {
    if (running < last.current) feed.runEnded();
    last.current = running;
  }, [feed, running]);
}

/**
 * The sidebar's foot for Usage: a thin upright bar per shown limit window,
 * filled with what is left in its provider's colour, grouped by account;
 * warn and fail colours when it runs low or out, faint when the reading is
 * old. The card tells each bar; a click opens Usage at its limits. Without
 * a bar to draw it is Usage's icon.
 */
export function Juicebars({ actions, feed, choices }: PageSummaryProps & { feed: LimitsFeed; choices: JuicebarChoices }) {
  const limits = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const chosen = useSyncExternalStore(choices.subscribe, choices.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);
  useRunEnded(feed);
  const card = useCard();
  const button = useRef<HTMLButtonElement>(null);
  // Keyboard focus opens the card; a click's focus does not.
  const pressed = useRef(false);
  const groups = juicebarGroups(limits, chosen, now);
  const open = () => actions.openPage?.(USAGE_PAGE, { section: "limits" });
  if (groups.length === 0) {
    return <button type="button" className="usage-juice-icon" {...tooltipProps("Usage", { side: "top" })} aria-label="Usage" onClick={open}><ChartColumn size={15} /></button>;
  }
  const label = `Plan limits, ${groups.map((entry) => `${titleOf(entry)}: ${entry.bars.map((bar) => `${bar.window.label} ${bar.state.kind === "expired" ? "reset" : `${bar.left}% left`}`).join(", ")}`).join("; ")}`;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="usage-juicebars"
        aria-label={label}
        aria-describedby={card.open ? "usage-juicecard" : undefined}
        onClick={() => { card.hide(); open(); }}
        onPointerEnter={card.enter}
        onPointerLeave={card.leave}
        onPointerDown={() => { pressed.current = true; }}
        onFocus={() => { if (!pressed.current) card.show(); pressed.current = false; }}
        onBlur={card.hide}
      >
        {groups.map((entry) => (
          <span key={entry.group.key} className="usage-juicebar-group" style={tone(entry)}>
            {entry.bars.map((bar) => <i key={bar.window.id} className="usage-juicebar" data-level={bar.level} style={{ "--usage-left": `${bar.left}%` } as CSSProperties} />)}
          </span>
        ))}
      </button>
      {card.open && button.current ? <JuiceCard groups={groups} now={now} anchor={button.current.getBoundingClientRect()} onEnter={card.stay} onLeave={card.leave} /> : null}
    </>
  );
}
