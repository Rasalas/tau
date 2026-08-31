import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { UiWorkspaceChanges, UiWorkspaceChangesPage } from "../../shared/contracts";
import { VirtualList } from "./VirtualList";
import { FileKindIcon } from "./FileKindIcon";
import { usePagedWorkspaceFiles } from "./usePagedWorkspaceFiles";

export function ChangedFiles({
  changes,
  onOpenDiff,
  label,
  loadFiles,
}: {
  changes: UiWorkspaceChanges;
  onOpenDiff(path?: string): void;
  /** Optional context shown in a transcript checkpoint card. */
  label?: string;
  /** Optional lazy file-list source for immutable checkpoint summaries. */
  loadFiles?(cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
}) {
  const [open, setOpen] = useState(false);
  const { files: loadedFiles, fileCount, hasMore, loading, error: loadError, loadNextPage } = usePagedWorkspaceFiles(changes, loadFiles);

  if (fileCount === 0) return null;
  const previewFiles = loadedFiles.slice(0, 3);
  const remainingFiles = Math.max(0, fileCount - previewFiles.length);

  return (
    <section className="transcript-card">
      <button
        className="changed-files-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={13} className="chev" /> : <ChevronRight size={13} className="chev" />}
        <strong>{label ? `${label} · ` : ""}{fileCount} changed {fileCount === 1 ? "file" : "files"}</strong>
        <span className="stat-add">+{changes.added}</span>
        <span className="stat-del">−{changes.removed}</span>
        <span className="spacer" />
        <span
          className="mini-button"
          role="button"
          tabIndex={0}
          onClick={(event) => { event.stopPropagation(); onOpenDiff(); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.stopPropagation(); onOpenDiff(); } }}
        >
          Open diff
        </span>
      </button>
      {!open ? (
        <button className="changed-files-preview" type="button" onClick={() => setOpen(true)}>
          <span className="changed-files-preview-pills">
            {previewFiles.map((file) => (
              <span className="changed-file-pill" title={file.path} key={file.path}>
                <FileKindIcon name={file.name} size={12} />
                <span>{file.name}</span>
              </span>
            ))}
          </span>
          {remainingFiles > 0 ? <strong className="changed-files-more">+{remainingFiles} more</strong> : null}
        </button>
      ) : null}
      {open ? <>
        <VirtualList items={loadedFiles} itemHeight={35} className="changed-files-list" renderItem={(file) => (
        <button className="changed-file-row" key={file.path} onClick={() => onOpenDiff(file.path)}>
          <FileKindIcon name={file.name} size={13} />
          <span className="path" title={file.path}>{file.path}</span><span className="stat-add">+{file.added}</span><span className="stat-del">−{file.removed}</span>
        </button>
        )} />
        {loadFiles && hasMore ? <div className="changed-files-more-row">
          <button className="text-button" disabled={loading} onClick={() => void loadNextPage()}>
            {loading ? "Loading…" : `Load more (${Math.max(0, fileCount - loadedFiles.length)} remaining)`}
          </button>
          {loadError ? <small className="file-tree-error">{loadError}</small> : null}
        </div> : null}
      </> : null}
    </section>
  );
}
