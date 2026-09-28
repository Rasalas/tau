import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp, FileDiff, TriangleAlert } from "lucide-react";
import { FileKindIcon, Popover, usePagedWorkspaceFiles, VirtualList, type UiWorkspaceChanges, type UiWorkspaceChangesPage } from "tau";

/** Hover waits this long before opening, so a pointer on its way to the composer opens nothing. */
export const TURN_CHANGES_OPEN_DELAY_MS = 180;
/** Leaving waits this long, so the pointer can cross from the pill to its detail. */
export const TURN_CHANGES_CLOSE_DELAY_MS = 220;

export interface TurnChangesProps {
  changes: UiWorkspaceChanges;
  /** The running turn's changes so far rather than a recorded checkpoint. */
  live?: boolean;
  onOpenDiff(path?: string): void;
  /** Starts the explicit confirmation flow for destructive restore. */
  onRestore?(): void;
  loadFiles?(cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
  /** Where the detail opens: above the composer it goes up, centred on the pill; in the transcript down. */
  side?: "top" | "bottom";
}

export function countFiles(count: number, partial = false): string {
  return `${count}${partial ? "+" : ""} ${count === 1 && !partial ? "file" : "files"}`;
}

/** Whether a turn has anything to show; a partial capture may have missed changes, so it always has. */
export function hasTurnChanges(changes: UiWorkspaceChanges): boolean {
  return changes.completeness === "partial" || (changes.fileCount ?? changes.files.length) > 0;
}

/**
 * A turn's changes as one pill: "2 files +4 −0". Hovering or clicking opens
 * the detail (the file list, Open diff, Rewind); a click keeps it open until
 * Escape or a press outside.
 */
export function TurnChangesPill({ changes, live = false, onOpenDiff, onRestore, loadFiles, side = "top" }: TurnChangesProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [byKeyboard, setByKeyboard] = useState(false);
  const open = pinned || hovered;

  useEffect(() => () => clearTimeout(timer.current), []);
  if (!hasTurnChanges(changes)) return null;
  const fileCount = changes.fileCount ?? changes.files.length;
  const partial = changes.completeness === "partial";
  const title = live ? "Changes so far" : "Turn changes";

  const hover = (next: boolean) => (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(next), next ? TURN_CHANGES_OPEN_DELAY_MS : TURN_CHANGES_CLOSE_DELAY_MS);
  };
  const close = () => {
    clearTimeout(timer.current);
    setPinned(false);
    setHovered(false);
  };
  const openDiff = (path?: string) => {
    close();
    onOpenDiff(path);
  };
  const Chevron = side === "top" ? ChevronUp : ChevronDown;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        // Over the composer it is one of the row's pills and wears their shared look.
        className={`turn-changes-pill${side === "top" ? " control-pill" : ""}${live ? " live" : ""}${open ? " open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${title}: ${countFiles(fileCount, partial)}, ${changes.added} lines added, ${changes.removed} removed`}
        onPointerEnter={hover(true)}
        onPointerLeave={hover(false)}
        onClick={(event) => {
          clearTimeout(timer.current);
          if (pinned) { close(); return; }
          // Enter or Space: move into the detail, whose portal sits outside the tab order.
          setByKeyboard(event.detail === 0);
          setPinned(true);
        }}
      >
        {live ? <span className="turn-changes-live" aria-hidden="true" /> : <FileDiff size={14} aria-hidden="true" />}
        <span className="turn-changes-count">{countFiles(fileCount, partial)}</span>
        {partial ? <TriangleAlert size={14} className="turn-changes-partial" aria-hidden="true" /> : null}
        <span className="stat-add">+{changes.added}</span>
        <span className="stat-del">−{changes.removed}</span>
        <Chevron size={14} className="chev" aria-hidden="true" />
      </button>
      {open ? (
        <Popover anchor={anchor} side={side} align={side === "top" ? "center" : "start"} label={title} className="turn-changes-popover" onClose={close}>
          <div className="turn-changes-detail" onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
            <TurnChangesDetail
              changes={changes}
              title={title}
              onOpenDiff={openDiff}
              onRestore={onRestore ? () => { close(); onRestore(); } : undefined}
              loadFiles={loadFiles}
              autoFocus={pinned && byKeyboard}
            />
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/** What the pill opens: the turn's files, each opening its diff, and the turn's own actions. */
export function TurnChangesDetail({ changes, title, onOpenDiff, onRestore, loadFiles, autoFocus = false }: {
  changes: UiWorkspaceChanges;
  title: string;
  onOpenDiff(path?: string): void;
  onRestore?(): void;
  loadFiles?(cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
  /** Opened from the keyboard: its first control takes the focus. */
  autoFocus?: boolean;
}) {
  const card = useRef<HTMLElement>(null);
  // Mount only: a detail opened by hover never takes the focus later.
  useEffect(() => {
    if (autoFocus) card.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  const { files, fileCount, hasMore, loading, error, loadNextPage } = usePagedWorkspaceFiles(changes, loadFiles);
  const partial = changes.completeness === "partial";
  return (
    <section ref={card} className="turn-changes-card">
      <header className="turn-changes-head">
        <strong>{title}</strong>
        <span className="turn-changes-count">{countFiles(fileCount, partial)}</span>
        <span className="stat-add">+{changes.added}</span>
        <span className="stat-del">−{changes.removed}</span>
        <span className="spacer" />
        {fileCount > 0 ? <button type="button" className="mini-button" onClick={() => onOpenDiff()}>Open diff</button> : null}
        {onRestore ? <button type="button" className="mini-button restore-mini-button" onClick={onRestore}>Rewind</button> : null}
      </header>
      {partial ? <p className="file-tree-error changed-files-warning">
        {changes.incompleteReason ?? "Snapshot coverage is partial; some workspace changes may be omitted."}
        {changes.omittedFileCount ? ` (${changes.omittedFileCount} file${changes.omittedFileCount === 1 ? "" : "s"} omitted)` : ""}
      </p> : null}
      {files.length > 0 ? <VirtualList items={files} itemHeight={35} className="changed-files-list" renderItem={(file) => (
        <button type="button" className="changed-file-row" key={file.path} onClick={() => onOpenDiff(file.path)}>
          <FileKindIcon name={file.name} size={13} />
          <span className="path" title={file.note ? `${file.path}: ${file.note}` : file.path}>{file.path}</span>
          <span className="stat-add">+{file.added}</span><span className="stat-del">−{file.removed}</span>
        </button>
      )} /> : null}
      {loadFiles && hasMore ? <div className="changed-files-more-row">
        <button type="button" className="text-button" disabled={loading} onClick={() => void loadNextPage()}>
          {loading ? "Loading…" : `Load more (${Math.max(0, fileCount - files.length)} remaining)`}
        </button>
        {error ? <small className="file-tree-error">{error}</small> : null}
      </div> : null}
    </section>
  );
}
