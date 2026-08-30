import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { UiWorkspaceChanges } from "../../shared/contracts";

export function ChangedFiles({
  changes,
  onOpenDiff,
}: {
  changes: UiWorkspaceChanges;
  onOpenDiff(path?: string): void;
}) {
  const [open, setOpen] = useState(true);
  if (changes.files.length === 0) return null;

  return (
    <section className="transcript-card">
      <button className="changed-files-header" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={13} className="chev" /> : <ChevronRight size={13} className="chev" />}
        <strong>{changes.files.length} changed {changes.files.length === 1 ? "file" : "files"}</strong>
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
      {open ? changes.files.map((file) => (
        <button className="changed-file-row" key={file.path} onClick={() => onOpenDiff(file.path)}>
          <span className="path" title={file.path}>{file.path}</span>
          <span className="stat-add">+{file.added}</span>
          <span className="stat-del">−{file.removed}</span>
        </button>
      )) : null}
    </section>
  );
}
