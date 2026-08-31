import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { UiWorkspaceChanges } from "../../shared/contracts";
import { VirtualList } from "./VirtualList";
import { FileKindIcon } from "./FileKindIcon";

export function ChangedFiles({
  changes,
  onOpenDiff,
  label,
}: {
  changes: UiWorkspaceChanges;
  onOpenDiff(path?: string): void;
  /** Optional context shown in a transcript checkpoint card. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  if (changes.files.length === 0) return null;
  const previewFiles = changes.files.slice(0, 3);
  const remainingFiles = changes.files.length - previewFiles.length;

  return (
    <section className="transcript-card">
      <button
        className="changed-files-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={13} className="chev" /> : <ChevronRight size={13} className="chev" />}
        <strong>{label ? `${label} · ` : ""}{changes.files.length} changed {changes.files.length === 1 ? "file" : "files"}</strong>
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
      {open ? <VirtualList items={changes.files} itemHeight={35} className="changed-files-list" renderItem={(file) => (
        <button className="changed-file-row" key={file.path} onClick={() => onOpenDiff(file.path)}>
          <FileKindIcon name={file.name} size={13} />
          <span className="path" title={file.path}>{file.path}</span><span className="stat-add">+{file.added}</span><span className="stat-del">−{file.removed}</span>
        </button>
      )} /> : null}
    </section>
  );
}
