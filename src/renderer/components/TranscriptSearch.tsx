import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, RotateCw, Search, X } from "lucide-react";
import type { TranscriptFindResult } from "../extension-system";
import { findWordTokens, foldFindWords, type TranscriptFindMode } from "../../workbench/transcript-find";
import type { UiMessage } from "../../shared/contracts";

export interface TranscriptSearchProps {
  /** The turns a client has loaded; the find starts here and stays here without `find`. */
  messages: readonly UiMessage[];
  /** The same query over the whole thread: its message ids, oldest first. */
  find?: (query: string, mode?: TranscriptFindMode) => Promise<TranscriptFindResult>;
  /** Brings a message into view, loading older turns for it first; false when it is not there. */
  onJump(messageId: string): Promise<boolean> | void;
  /** The query and the message the find stands on, for marking the words in the text. */
  onActive?(query: string, messageId: string | undefined, mode?: TranscriptFindMode): void;
  onClose(): void;
  /** A new value takes the keyboard back into the bar and selects the query, as a second ⌘F does in a browser. */
  focusToken?: number;
  initialQuery?: string;
  initialMode?: TranscriptFindMode;
}

/** Typing pauses this long before the whole thread is asked. */
export const FIND_DEBOUNCE_MS = 200;

type Remote = { query: string; mode: TranscriptFindMode; ids?: readonly string[]; truncated?: boolean; failed?: boolean };

/** A streamed delta replaces one message; every other one keeps its lowercased text. */
const loweredText = new WeakMap<UiMessage, string>();
function lowered(message: UiMessage): string {
  let text = loweredText.get(message);
  if (text === undefined) {
    // The NUL keeps a query from matching across the end of the text into the thinking.
    text = `${message.text?.toLowerCase() ?? ""}\0${message.thinking?.toLowerCase() ?? ""}`;
    loweredText.set(message, text);
  }
  return text;
}

export function TranscriptSearch({ messages, find, onJump, onActive, onClose, focusToken, initialQuery, initialMode }: TranscriptSearchProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [mode, setMode] = useState<TranscriptFindMode>(initialMode ?? "literal");
  useEffect(() => { setMode(initialMode ?? "literal"); }, [initialMode, focusToken]);
  useEffect(() => { if (initialQuery !== undefined) setQuery(initialQuery); }, [initialQuery, focusToken]);
  const [remote, setRemote] = useState<Remote>();
  const [attempt, setAttempt] = useState(0);
  const [activeId, setActiveId] = useState<string>();
  const [jumping, setJumping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const jumpToken = useRef(0);
  const needle = query.trim();

  const loaded = useMemo(() => {
    const q = needle.toLowerCase();
    if (!q) return [];
    if (mode === "all-words") {
      const tokens = findWordTokens(needle);
      // Only a fallback while the whole-thread finder is unavailable. Global hits
      // search visible message text, never tokens spread over text and thinking.
      return messages.filter(msg => (msg.role === "user" || msg.role === "assistant")
        && tokens.every(token => foldFindWords(msg.text ?? "").includes(token))).map(msg => msg.id).slice(0, 1);
    }
    return messages.filter((msg) => lowered(msg).includes(q)).map((msg) => msg.id);
  }, [messages, needle, mode]);

  // Newest first: the reader is at the end and walks back through the thread.
  const current = remote?.query === needle && remote.mode === mode ? remote : undefined;
  const whole = current?.ids;
  const failed = current?.failed === true;
  const partial = failed || current?.truncated === true;
  const searching = Boolean(find && needle && !whole && !failed);
  // Wait for the authoritative best message before scrolling. A loaded tail may
  // hold an incidental substring while the global snippet belongs to an older turn.
  const matches = useMemo(() => [...(whole ?? (mode === "all-words" && searching ? [] : loaded))].reverse(), [loaded, whole, mode, searching]);
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  useEffect(() => {
    if (!find || !needle) { setRemote(undefined); return; }
    let active = true;
    setRemote(undefined);
    const timer = setTimeout(() => {
      (mode === "literal" ? find(needle) : find(needle, mode)).then(
        (answer) => {
          if (!active) return;
          const result = "messageIds" in answer ? answer : { messageIds: answer, truncated: false };
          setRemote({ query: needle, mode, ids: result.messageIds, truncated: result.truncated });
        },
        () => { if (active) setRemote({ query: needle, mode, failed: true }); },
      );
    }, FIND_DEBOUNCE_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [find, needle, mode, attempt]);

  const goTo = (id: string | undefined) => {
    setActiveId(id);
    if (!id) return;
    const token = ++jumpToken.current;
    const done = onJump(id);
    if (!done) return;
    setJumping(true);
    void done.finally(() => { if (token === jumpToken.current) setJumping(false); });
  };

  // The find starts at the newest match and keeps its place while the query grows or the whole thread's answer
  // arrives, as long as the message it stands on still matches.
  useEffect(() => {
    if (!needle || matches.length === 0) { setActiveId(undefined); return; }
    if (activeId && matches.includes(activeId)) return;
    goTo(matches[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, matches]);

  useEffect(() => {
    if (mode === "all-words") onActive?.(needle, activeId, mode);
    else onActive?.(needle, activeId);
  }, [needle, activeId, mode, onActive]);
  useEffect(() => () => onActive?.("", undefined), [onActive]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  const position = activeId ? matches.indexOf(activeId) : -1;
  const step = (delta: number) => {
    if (matches.length === 0) return;
    goTo(matches[((position < 0 ? 0 : position + delta) + matches.length) % matches.length]);
  };

  let count = "";
  if (needle) {
    if (matches.length > 0) count = jumping ? "Loading…" : `${Math.max(position, 0) + 1} of ${matches.length}${searching || partial ? "+" : ""}`;
    else count = searching ? "Searching…" : partial ? "" : "0 matches";
    if (failed) count += `${count ? " · " : ""}Search failed; loaded messages only`;
    else if (partial) count += `${count ? " · " : ""}Partial search`;
  }

  return (
    <div className="transcript-search-bar" role="search" aria-label="Search transcript">
      <Search size={14} color="var(--muted)" />
      <input
        ref={inputRef}
        type="text"
        placeholder="Find in transcript…"
        value={query}
        onChange={(e) => { setMode("literal"); setQuery(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="search-count" aria-live="polite">{count}</span>
      {failed ? <button type="button" aria-label="Retry search" title="Retry search" onClick={() => { setRemote(undefined); setAttempt((value) => value + 1); }}><RotateCw size={14} /></button> : null}
      <button
        type="button"
        title="Older match (Enter)"
        aria-label="Older match"
        disabled={matches.length === 0}
        onClick={() => step(1)}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        title="Newer match (⇧Enter)"
        aria-label="Newer match"
        disabled={matches.length === 0}
        onClick={() => step(-1)}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        title="Close search (Esc)"
        aria-label="Close search"
        onClick={onClose}
      >
        <X size={14} />
      </button>
    </div>
  );
}
