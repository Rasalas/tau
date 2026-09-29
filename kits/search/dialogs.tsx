import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { errorMessage, FileKindIcon, VirtualList, type WorkbenchActions } from "tau";
import type { ContentMatch, ContentSearchResult, FileSearchResult, SearchHostCommands } from "./protocol.js";

export type SearchHost = <K extends keyof SearchHostCommands>(command: K, input: SearchHostCommands[K]["input"]) => Promise<SearchHostCommands[K]["output"]>;

export type SearchDialog = "content" | "files";

/** Which of the kit's two dialogs is open; a command toggles one. */
export class SearchDialogs {
  private open: SearchDialog | undefined;
  private readonly listeners = new Set<() => void>();
  /** Where the file picker hands its pick when another kit opened it; the stage otherwise. */
  onPick: ((path: string) => void) | undefined;

  toggle(dialog: SearchDialog): void {
    this.onPick = undefined;
    this.set(this.open === dialog ? undefined : dialog);
  }

  /** "Go to file" for another kit: a phone's Files sheet reads the pick itself, having no stage. */
  pickFile(onPick?: (path: string) => void): void {
    this.onPick = onPick;
    this.set("files");
  }

  close(): void {
    this.onPick = undefined;
    this.set(undefined);
  }

  getSnapshot = (): SearchDialog | undefined => this.open;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(open: SearchDialog | undefined): void {
    if (this.open === open) return;
    this.open = open;
    for (const listener of [...this.listeners]) listener();
  }
}

const CONTENT_DELAY_MS = 150;
const FILES_DELAY_MS = 40;
const ROW_HEIGHT = 28;
/** A finger's row on a compact client. */
const TOUCH_ROW_HEIGHT = 44;

/** Whether the workbench lays out for touch (`body[data-profile="compact"]`: a phone, a tablet). */
function useCompactLayout(): boolean {
  const read = () => typeof document !== "undefined" && document.body.dataset.profile === "compact";
  const [compact, setCompact] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setCompact(read()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-profile"] });
    return () => observer.disconnect();
  }, []);
  return compact;
}

/** Marks the given `[start, end)` ranges of `text`. */
export function marked(text: string, ranges: ReadonlyArray<readonly [number, number]>): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < at) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** Single positions as ranges, joining neighbours so a run reads as one mark. */
export function positionRanges(positions: readonly number[], offset = 0): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const position of positions) {
    const at = position - offset;
    if (at < 0) continue;
    const last = ranges.at(-1);
    if (last && last[1] === at) last[1] = at + 1;
    else ranges.push([at, at + 1]);
  }
  return ranges;
}

function splitPath(path: string): { name: string; directory: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, directory: "" } : { name: path.slice(slash + 1), directory: path.slice(0, slash) };
}

function Frame({ label, children, onClose }: { label: string; children: ReactNode; onClose(): void }) {
  return <div className="search-backdrop" onMouseDown={onClose}>
    <section className="search-dialog" role="dialog" aria-modal="true" aria-label={label} onMouseDown={(event) => event.stopPropagation()}>
      {children}
    </section>
  </div>;
}

/** A touch screen may have no Escape: the dialog closes from its own row. */
function CloseButton({ label, onClose }: { label: string; onClose(): void }) {
  return <button type="button" className="search-close" aria-label={`Close ${label}`} onClick={onClose}><X size={18} /></button>;
}

function useFocus() {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return input;
}

function moveCursor(event: KeyboardEvent, length: number, setCursor: (change: (value: number) => number) => void): boolean {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
  event.preventDefault();
  if (length === 0) return true;
  const step = event.key === "ArrowDown" ? 1 : -1;
  setCursor((value) => (value + step + length) % length);
  return true;
}

type ContentRow =
  | { kind: "file"; path: string; count: number }
  | { kind: "match"; match: ContentMatch; index: number };

export function contentRows(matches: readonly ContentMatch[]): ContentRow[] {
  const rows: ContentRow[] = [];
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
  let previous: string | undefined;
  matches.forEach((match, index) => {
    if (match.path !== previous) rows.push({ kind: "file", path: match.path, count: counts.get(match.path) ?? 0 });
    previous = match.path;
    rows.push({ kind: "match", match, index });
  });
  return rows;
}

function Toggle({ label, pressed, onToggle, children }: { label: string; pressed: boolean; onToggle(): void; children: ReactNode }) {
  return <button type="button" className="search-toggle" aria-label={label} title={label} aria-pressed={pressed} onClick={onToggle}>{children}</button>;
}

export function ContentSearchDialog({ host, channel, actions, onClose }: { host: SearchHost; channel: string; actions: WorkbenchActions; onClose(): void }) {
  const cwd = actions.activeThread()?.cwd;
  const input = useFocus();
  const touch = useCompactLayout();
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [answer, setAnswer] = useState<{ key: string; result?: ContentSearchResult; error?: string }>();
  const [cursor, setCursor] = useState(0);
  const key = JSON.stringify([query, regex, caseSensitive, wholeWord]);

  useEffect(() => {
    if (!query || !cwd) { void host("content", { query: "", channel }).catch(() => undefined); return; }
    let live = true;
    const timer = setTimeout(() => {
      host("content", { cwd, query, regex, caseSensitive, wholeWord, channel }).then(
        (result) => { if (live && !result.cancelled) setAnswer({ key, result }); },
        (error: unknown) => { if (live) setAnswer({ key, error: errorMessage(error) }); },
      );
    }, CONTENT_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [caseSensitive, channel, cwd, host, key, query, regex, wholeWord]);
  // Leaving stops whatever search is still running.
  useEffect(() => () => { void host("content", { query: "", channel }).catch(() => undefined); }, [channel, host]);
  useEffect(() => setCursor(0), [answer]);

  const current = answer?.key === key ? answer : undefined;
  const pending = Boolean(query) && !current;
  const matches = current?.result?.matches ?? [];
  const rows = useMemo(() => contentRows(matches), [matches]);
  const selectedRow = rows.findIndex((row) => row.kind === "match" && row.index === cursor);
  const files = new Set(matches.map((match) => match.path)).size;

  const open = (match: ContentMatch) => {
    actions.openFile(match.path, { line: match.line });
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
    if (moveCursor(event, matches.length, setCursor)) return;
    // What is on the list belongs to the previous query while a newer one runs.
    if (event.key === "Enter" && !pending && matches[cursor]) { event.preventDefault(); open(matches[cursor]); }
  };

  const status = !cwd ? "Open a project to search its files."
    : pending ? "Searching…"
      : current?.error ?? current?.result?.error
        ?? (current?.result ? `${matches.length}${current.result.truncated ? "+" : ""} ${matches.length === 1 ? "result" : "results"} in ${files} ${files === 1 ? "file" : "files"}${current.result.engine === "walker" ? " · ripgrep is not installed, so Tau read the files itself" : ""}` : "Type to search the project's files.");

  return <Frame label="Search in project" onClose={onClose}>
    <div className="search-input">
      <input
        ref={input}
        value={query}
        disabled={!cwd}
        placeholder="Search in project"
        aria-label="Search in project"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Toggle label="Match case" pressed={caseSensitive} onToggle={() => setCaseSensitive((value) => !value)}>Aa</Toggle>
      <Toggle label="Match whole word" pressed={wholeWord} onToggle={() => setWholeWord((value) => !value)}><u>ab</u></Toggle>
      <Toggle label="Use regular expression" pressed={regex} onToggle={() => setRegex((value) => !value)}>.*</Toggle>
      {touch ? <CloseButton label="Search in project" onClose={onClose} /> : null}
    </div>
    <div className="search-status" role="status" data-error={current?.error || current?.result?.error ? "true" : undefined}>{status}</div>
    <VirtualList
      items={rows}
      itemHeight={touch ? TOUCH_ROW_HEIGHT : ROW_HEIGHT}
      className="search-results"
      scrollToIndex={selectedRow >= 0 ? selectedRow : undefined}
      renderItem={(row) => {
        if (row.kind === "file") {
          const { name, directory } = splitPath(row.path);
          return <div key={`file:${row.path}`} className="search-file-row">
            <span className="search-file-icon"><FileKindIcon name={name} /></span>
            <strong>{name}</strong><small>{directory}</small><b>{row.count}</b>
          </div>;
        }
        return <button
          key={`match:${row.index}`}
          type="button"
          className={`search-match-row${row.index === cursor ? " selected" : ""}`}
          disabled={pending}
          onMouseMove={() => setCursor(row.index)}
          onClick={() => open(row.match)}
        >
          <span className="search-line-number">{row.match.line}</span>
          <code>{marked(row.match.text, row.match.ranges)}</code>
        </button>;
      }}
    />
    <footer className="search-footer"><span>↑↓ move</span><span>↵ open at the line</span><span>esc close</span></footer>
  </Frame>;
}

export function FilePickerDialog({ host, actions, onPick, onClose }: { host: SearchHost; actions: WorkbenchActions; onPick?(path: string): void; onClose(): void }) {
  const cwd = actions.activeThread()?.cwd;
  const touch = useCompactLayout();
  const input = useFocus();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<{ query: string; result?: FileSearchResult; error?: string }>();
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (!cwd) return;
    let live = true;
    const timer = setTimeout(() => {
      host("files", { cwd, query, limit: 60 }).then(
        (result) => { if (live) setAnswer({ query, result }); },
        (error: unknown) => { if (live) setAnswer({ query, error: errorMessage(error) }); },
      );
    }, query ? FILES_DELAY_MS : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [cwd, host, query]);
  useEffect(() => setCursor(0), [answer]);

  const files = answer?.result?.files ?? [];
  const open = (path: string) => {
    if (onPick) onPick(path);
    else actions.openFile(path);
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
    if (moveCursor(event, files.length, setCursor)) return;
    if (event.key === "Enter" && answer?.query === query && files[cursor]) { event.preventDefault(); open(files[cursor].path); }
  };
  const status = !cwd ? "Open a project to pick one of its files."
    : answer?.error ?? (answer?.result ? `${answer.result.total.toLocaleString()} files in the project` : "Reading the project's files…");

  return <Frame label="Go to file" onClose={onClose}>
    <div className="search-input">
      <input
        ref={input}
        value={query}
        disabled={!cwd}
        placeholder="Go to file"
        aria-label="Go to file"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {touch ? <CloseButton label="Go to file" onClose={onClose} /> : null}
    </div>
    <div className="search-status" role="status" data-error={answer?.error ? "true" : undefined}>{status}</div>
    <VirtualList
      items={files}
      itemHeight={touch ? TOUCH_ROW_HEIGHT : ROW_HEIGHT + 4}
      className="search-results"
      scrollToIndex={cursor}
      empty={answer?.result && query ? <p className="search-empty">No file matches “{query}”.</p> : null}
      renderItem={(file, index) => {
        const { name, directory } = splitPath(file.path);
        const nameStart = file.path.length - name.length;
        return <button
          key={file.path}
          type="button"
          className={`search-pick-row${index === cursor ? " selected" : ""}`}
          onMouseMove={() => setCursor(index)}
          onClick={() => open(file.path)}
        >
          <span className="search-file-icon"><FileKindIcon name={name} /></span>
          <strong>{marked(name, positionRanges(file.positions, nameStart))}</strong>
          <small>{marked(directory, positionRanges(file.positions.filter((position) => position < directory.length)))}</small>
        </button>;
      }}
    />
    <footer className="search-footer"><span>↑↓ move</span><span>↵ open</span><span>esc close</span></footer>
  </Frame>;
}

/** Mounted once in the title bar; draws whichever dialog is open over the whole window. */
export function SearchDialogsLayer({ dialogs, host, channel, actions }: { dialogs: SearchDialogs; host: SearchHost; channel: string; actions: WorkbenchActions }) {
  const open = useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot);
  if (!open || typeof document === "undefined") return null;
  const close = () => dialogs.close();
  return createPortal(open === "content"
    ? <ContentSearchDialog host={host} channel={channel} actions={actions} onClose={close} />
    : <FilePickerDialog host={host} actions={actions} {...(dialogs.onPick ? { onPick: dialogs.onPick } : {})} onClose={close} />, document.body);
}
