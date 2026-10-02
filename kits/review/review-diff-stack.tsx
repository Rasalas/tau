import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, ChevronRight, ExternalLink, TriangleAlert } from "lucide-react";
import { DiffView, errorMessage, FileKindIcon, tooltipProps, type DiffLineSlot, type UiFileDiff } from "tau";

export interface StackFile {
  path: string;
  added: number;
  removed: number;
  /** A rename says where the file came from. */
  previousPath?: string;
  conflict?: boolean;
}

/** A file with more lines than this scrolls inside its card, where the diff view draws only the rows in view. */
export const BOUNDED_LINES = 400;
/** How far below the viewport a file is fetched and drawn. */
const AHEAD = "900px";

const lineCount = (diff: UiFileDiff) => diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
/** A stand-in's height before its diff is there, so the scrollbar is about right. */
const guess = (file: StackFile) => Math.min(640, Math.max(96, (file.added + file.removed) * 24 + 40));

function useOnScreen(root: RefObject<HTMLElement | null>, paths: readonly string[], options: IntersectionObserverInit, onChange: (path: string, visible: boolean) => void) {
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    const scroll = root.current;
    if (!scroll || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const path = (entry.target as HTMLElement).dataset.path;
        if (path) change.current(path, entry.isIntersecting);
      }
    }, { root: scroll, ...options });
    for (const element of scroll.querySelectorAll<HTMLElement>("[data-stack-file]")) observer.observe(element);
    return () => observer.disconnect();
    // The options are literals of the caller's; the files decide what is observed.
  }, [root, paths]); // eslint-disable-line react-hooks/exhaustive-deps
}

const FileBody = memo(function FileBody({ path, diff, read, version, layout, wrap, lines, unavailable }: {
  path: string;
  diff?: UiFileDiff | undefined;
  read?: ((path: string) => Promise<UiFileDiff>) | undefined;
  /** Another value reads the diff again (the branch moved). */
  version?: string | undefined;
  layout: "unified" | "split";
  wrap: boolean;
  lines?: DiffLineSlot | undefined;
  unavailable?: string | undefined;
}) {
  const [read_, setRead] = useState<UiFileDiff>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!read || diff) return;
    let live = true;
    setError(undefined);
    read(path).then((answer) => { if (live) setRead(answer); }, (reason) => { if (live) setError(errorMessage(reason)); });
    return () => { live = false; };
  }, [read, diff, path, version]);
  const shown = diff ?? read_;
  if (unavailable) return <p className="rvd-note-line">{unavailable}</p>;
  if (error) return <p className="rvd-note-line rvd-error" role="alert">{error}</p>;
  if (!shown) return <div className="rvd-loading" role="status" aria-label={`Loading ${path}`} />;
  const bounded = lineCount(shown) > BOUNDED_LINES;
  return <div className={`rvd-diff${bounded ? " bounded" : ""}`}><DiffView diff={shown} mode={layout} path={path} wrap={wrap} {...(lines ? { lines } : {})} /></div>;
});

/**
 * Every file of a review under the next, each with a header of its own that
 * folds it, as GitHub and GitLab draw a change. A file is fetched and drawn
 * only when it comes within a screen or two of the viewport, and a long one
 * scrolls inside its card so the diff view can keep to the rows in view.
 */
export function ReviewDiffStack({ files, layout, wrap, diffs, read, version, lines, extra, body, onOpenInEditor, jump, onActive, unavailable, scroll }: {
  files: readonly StackFile[];
  layout: "unified" | "split";
  wrap: boolean;
  /** Diffs the page already holds (a pull request's), by path. */
  diffs?: ReadonlyMap<string, UiFileDiff>;
  /** Reads one file's diff when it is drawn (a local review's). */
  read?: (path: string) => Promise<UiFileDiff>;
  version?: string;
  lines?: (path: string) => DiffLineSlot | undefined;
  /** Beside "Open in editor" in a file's header. */
  extra?: (file: StackFile) => ReactNode;
  /** A file drawn otherwise than as its diff (a conflict's hunks to pick). */
  body?: (file: StackFile) => ReactNode;
  onOpenInEditor?: (path: string) => void;
  /** A click on a file in the sidebar: another `at` scrolls to `path` again. */
  jump?: { path: string; at: number } | undefined;
  onActive?: (path: string) => void;
  /** Why no diff can be read, for a review whose worktree is gone. */
  unavailable?: string;
  /** The element the stack scrolls in. */
  scroll: RefObject<HTMLElement | null>;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const observed = typeof IntersectionObserver !== "undefined";
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const sections = useRef(new Map<string, HTMLElement>());

  useOnScreen(scroll, paths, { rootMargin: `${AHEAD} 0px` }, (path, visible) => {
    if (!visible) return;
    setNear((current) => current.has(path) ? current : new Set(current).add(path));
  });
  // The file at the top of the page is the first of those in its top fifth.
  const band = useRef(new Set<string>());
  useOnScreen(scroll, paths, { rootMargin: "0px 0px -80% 0px" }, (path, visible) => {
    if (visible) band.current.add(path); else band.current.delete(path);
    const first = paths.find((candidate) => band.current.has(candidate));
    if (first) onActive?.(first);
  });

  useEffect(() => {
    if (!jump) return;
    setFolded((current) => { if (!current.has(jump.path)) return current; const next = new Set(current); next.delete(jump.path); return next; });
    setNear((current) => current.has(jump.path) ? current : new Set(current).add(jump.path));
    sections.current.get(jump.path)?.scrollIntoView?.({ block: "start" });
  }, [jump]);

  const toggle = (path: string) => setFolded((current) => {
    const next = new Set(current);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  return (
    <div className="rvd-stack">
      {files.map((file) => {
        const closed = folded.has(file.path);
        const drawn = !observed || near.has(file.path);
        return (
          <section
            key={file.path}
            className={`rvd-file${closed ? " folded" : ""}`}
            data-stack-file=""
            data-path={file.path}
            aria-label={file.path}
            ref={(element) => { if (element) sections.current.set(file.path, element); else sections.current.delete(file.path); }}
          >
            <header className="rvd-file-head">
              <button type="button" className="rvd-fold" aria-expanded={!closed} aria-label={`${closed ? "Expand" : "Collapse"} ${file.path}`} onClick={() => toggle(file.path)}>
                {closed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                <FileKindIcon name={file.path} />
                <span className="rvd-path" title={file.path}>{file.path}</span>
              </button>
              {file.previousPath ? <span className="rvd-from">from {file.previousPath}</span> : null}
              {file.conflict ? <span className="rvd-conflict" {...tooltipProps("Changed on both sides")}><TriangleAlert size={12} aria-hidden="true" /></span> : null}
              <span className="rvd-count">
                {file.added ? <span className="stat-add">+{file.added}</span> : null}
                {file.removed ? <span className="stat-del">−{file.removed}</span> : null}
              </span>
              {extra?.(file)}
              {onOpenInEditor ? (
                <button type="button" className="rvd-open" onClick={() => onOpenInEditor(file.path)}>
                  <ExternalLink size={12} aria-hidden="true" /> Open in editor
                </button>
              ) : null}
            </header>
            {closed ? null : body?.(file) ?? (drawn
              ? <FileBody path={file.path} diff={diffs?.get(file.path)} read={read} version={version} layout={layout} wrap={wrap} lines={lines?.(file.path)} unavailable={unavailable} />
              : <div className="rvd-loading" style={{ height: guess(file) }} aria-hidden="true" />)}
          </section>
        );
      })}
    </div>
  );
}
