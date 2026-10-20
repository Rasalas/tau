import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";

export interface TranscriptSearchProps {
  /** The turns a client has loaded; the find starts here and stays here without `find`. */
  messages: readonly UiMessage[];
  /** The same query over the whole thread: its message ids, oldest first. */
  find?: (query: string) => Promise<readonly string[]>;
  /** Brings a message into view, loading older turns for it first; false when it is not there. */
  onJump(messageId: string): Promise<boolean> | void;
  /** The query and the message the find stands on, for marking the words in the text. */
  onActive?(query: string, messageId: string | undefined): void;
  onClose(): void;
  /** A new value takes the keyboard back into the bar and selects the query, as a second ⌘F does in a browser. */
  focusToken?: number;
}

/** Typing pauses this long before the whole thread is asked. */
export const FIND_DEBOUNCE_MS = 200;

type Remote = { query: string; ids: readonly string[] } | "failed";

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

export function TranscriptSearch({ messages, find, onJump, onActive, onClose, focusToken }: TranscriptSearchProps) {
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<Remote>();
  const [activeId, setActiveId] = useState<string>();
  const [jumping, setJumping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const jumpToken = useRef(0);
  const needle = query.trim();

  const loaded = useMemo(() => {
    const q = needle.toLowerCase();
    if (!q) return [];
    return messages.filter((msg) => lowered(msg).includes(q)).map((msg) => msg.id);
  }, [messages, needle]);

  // Newest first: the reader is at the end and walks back through the thread.
  const whole = remote && remote !== "failed" && remote.query === needle ? remote.ids : undefined;
  const matches = useMemo(() => [...(whole ?? loaded)].reverse(), [loaded, whole]);
  const searching = Boolean(find && needle && !whole && remote !== "failed");
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  useEffect(() => {
    if (!find || !needle) { setRemote(undefined); return; }
    let current = true;
    const timer = setTimeout(() => {
      find(needle).then(
        (ids) => { if (current) setRemote({ query: needle, ids }); },
        () => { if (current) setRemote("failed"); },
      );
    }, FIND_DEBOUNCE_MS);
    return () => { current = false; clearTimeout(timer); };
  }, [find, needle]);

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

  useEffect(() => { onActive?.(needle, activeId); }, [needle, activeId, onActive]);
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
    if (matches.length > 0) count = jumping ? "Loading…" : `${Math.max(position, 0) + 1} of ${matches.length}${searching ? "+" : ""}`;
    else count = searching ? "Searching…" : "0 matches";
  }

  return (
    <div className="transcript-search-bar" role="search" aria-label="Search transcript">
      <Search size={14} color="var(--muted)" />
      <input
        ref={inputRef}
        type="text"
        placeholder="Find in transcript…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
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
