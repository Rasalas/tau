import { useCallback, useEffect, useState } from "react";
import { Globe, History, X } from "lucide-react";
import { tooltipProps } from "tau";
import type { PreviewHistoryEntry } from "./protocol.js";
import { previewKit } from "./store.js";

/** `localhost:3000/settings`, the way T3 Code's recent card writes an address. */
export function pageLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
export function visitedAgo(at: number, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** Recent pages whose address or title holds what was typed; all of them for nothing typed. */
export function matchingPages(entries: readonly PreviewHistoryEntry[], typed: string, current: string): PreviewHistoryEntry[] {
  const needle = typed.trim().toLowerCase();
  return entries.filter((entry) => entry.url !== current && (!needle || entry.url.toLowerCase().includes(needle) || entry.title?.toLowerCase().includes(needle)));
}

/** The host's list of recent pages, read when shown and whenever the page changes. */
export function useRecentPages(url: string): { entries: PreviewHistoryEntry[]; forget(url: string): void } {
  const [entries, setEntries] = useState<PreviewHistoryEntry[]>([]);
  useEffect(() => {
    let live = true;
    void previewKit.history().then((list) => { if (live && Array.isArray(list)) setEntries(list); }).catch(() => undefined);
    return () => { live = false; };
  }, [url]);
  const forget = useCallback((target: string) => {
    setEntries((current) => current.filter((entry) => entry.url !== target));
    void previewKit.forget({ url: target }).then((list) => { if (Array.isArray(list)) setEntries(list); }).catch(() => undefined);
  }, []);
  return { entries, forget };
}

function RecentRow({ entry, onOpen, onForget, compact }: { entry: PreviewHistoryEntry; onOpen(url: string): void; onForget(url: string): void; compact?: boolean }) {
  const label = pageLabel(entry.url);
  return <li className={compact ? "preview-recent compact" : "preview-recent"}>
    <button
      type="button"
      className="preview-recent-open"
      // Keeps the address field focused, so the list does not vanish under the click.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onOpen(entry.url)}
      {...tooltipProps(entry.url, { variant: "code", when: "truncated" })}
    >
      <Globe size={compact ? 11 : 14} aria-hidden="true" />
      <span className="preview-recent-text">
        <strong>{entry.title ?? label}</strong>
        <small>{entry.title ? `${label} · ` : ""}{visitedAgo(entry.visitedAt)}</small>
      </span>
    </button>
    <button
      type="button"
      className="icon-button compact preview-recent-forget"
      aria-label={`Remove ${label} from recent pages`}
      {...tooltipProps("Remove from recent pages")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onForget(entry.url)}
    ><X size={12} /></button>
  </li>;
}

/** What the empty panel offers: the pages shown before, newest first. */
export function RecentPages({ entries, onOpen, onForget }: { entries: readonly PreviewHistoryEntry[]; onOpen(url: string): void; onForget(url: string): void }) {
  const shown = entries.slice(0, 8);
  if (shown.length === 0) {
    return <div className="preview-empty">
      <Globe size={18} aria-hidden="true" />
      <strong>No preview yet</strong>
      <p>Type a URL above or run a dev server; local servers show up above the page.</p>
    </div>;
  }
  return <section className="preview-empty list" aria-label="Recently used">
    <h3><History size={13} aria-hidden="true" /> Recently used</h3>
    <ul className="preview-recents">
      {shown.map((entry) => <RecentRow key={entry.url} entry={entry} onOpen={onOpen} onForget={onForget} />)}
    </ul>
  </section>;
}

/** Under the address while it has focus: recent pages that match what is typed. */
export function RecentSuggestions({ entries, typed, current, onOpen, onForget }: {
  entries: readonly PreviewHistoryEntry[];
  typed: string;
  current: string;
  onOpen(url: string): void;
  onForget(url: string): void;
}) {
  const shown = matchingPages(entries, typed === current ? "" : typed, current).slice(0, 5);
  if (shown.length === 0) return null;
  return <ul className="preview-recents suggestions" aria-label="Recent pages">
    {shown.map((entry) => <RecentRow key={entry.url} entry={entry} onOpen={onOpen} onForget={onForget} compact />)}
  </ul>;
}
