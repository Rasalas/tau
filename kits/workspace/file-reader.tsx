import { useEffect, useState } from "react";
import { ChevronLeft, FileWarning, RotateCw } from "lucide-react";
import { Empty, errorMessage, FileSource, MiddleTruncate, Spinner, type UiFileContent } from "tau";

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file read in a phone's Files sheet, where no stage is drawn. Reading
 * only: a sheet a pull closes is no place for unsaved edits, and the
 * on-screen keyboard leaves a phone a few lines of code. A tablet and the
 * desktop edit.
 */
export function FileReader({ path, load, onBack }: { path: string; load(path: string): Promise<UiFileContent>; onBack(): void }) {
  const [loaded, setLoaded] = useState<{ path: string; content?: UiFileContent; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoaded(undefined);
    load(path).then(
      (content) => { if (live) setLoaded({ path, content }); },
      (error: unknown) => { if (live) setLoaded({ path, error: errorMessage(error) }); },
    );
    return () => { live = false; };
  }, [attempt, load, path]);

  const name = path.split("/").at(-1) ?? path;
  const content = loaded?.path === path ? loaded.content : undefined;
  const error = loaded?.path === path ? loaded.error : undefined;
  let body;
  if (error) {
    body = <Empty
      icon={<FileWarning size={20} />}
      title="Could not read this file"
      description={error}
    ><button type="button" className="file-reader-button" onClick={() => setAttempt((count) => count + 1)}><RotateCw size={16} aria-hidden="true" />Try again</button></Empty>;
  } else if (!content) {
    body = <div className="file-reader-loading"><Spinner label="Reading the file" /></div>;
  } else if (content.kind === "image") {
    body = <div className="file-reader-image"><img src={content.dataUrl} alt={name} /></div>;
  } else if (content.kind === "binary") {
    body = <Empty icon={<FileWarning size={20} />} title="Nothing to read here" description={`${name} is a binary file (${formatSize(content.size)}).`} />;
  } else {
    body = <FileSource content={content} />;
  }

  return <div className="file-reader">
    <header className="file-reader-header">
      <button type="button" className="file-reader-back" aria-label="Back to the files" onClick={onBack}><ChevronLeft size={20} aria-hidden="true" /></button>
      <div className="file-reader-title">
        <strong>{name}</strong>
        <MiddleTruncate className="file-reader-path" value={path} />
      </div>
      {content ? <small className="file-reader-meta">{formatSize(content.size)}</small> : null}
    </header>
    <p className="file-reader-note" role="note">Read only on a phone. Edit it on a tablet or the desktop.</p>
    <div className="file-reader-body">{body}</div>
  </div>;
}
