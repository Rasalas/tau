import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage, useClientEnvironment } from "tau";
import type { WorkspaceStoreLike } from "./kit.js";

/** Uses the same Blob/anchor download as the existing export actions. */
export function DownloadFileButton({ store, path, workspace, onError }: { store?: WorkspaceStoreLike; path: string; workspace: string; onError?(message: string | undefined): void }) {
  const environment = useClientEnvironment();
  const active = useRef<AbortController | undefined>(undefined);
  const urls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const reportError = (message: string | undefined) => { setError(message); onError?.(message); };
  useEffect(() => {
    setBusy(false); setError(undefined);
    const owned = urls.current;
    return () => {
      const pending = active.current;
      active.current = undefined;
      pending?.abort();
      for (const [url, timer] of owned) { clearTimeout(timer); URL.revokeObjectURL(url); }
      owned.clear();
    };
  }, [store, path, workspace]);
  const download = async () => {
    if (active.current) return;
    reportError(undefined);
    // The existing Android openDocument port accepts PDFs only. Neither native
    // shell offers a general save/share port for these passive formats yet.
    if (environment.mobileApp || !("download" in document.createElement("a"))) {
      reportError("This app cannot save this file. Open Tau in a browser or desktop window to download it.");
      return;
    }
    if (!store?.downloadFile) {
      reportError("This version of Workspace does not support file downloads. Update Tau and try again.");
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const file = await store.downloadFile(path, { workspace }, controller.signal);
      controller.signal.throwIfAborted();
      if (!file.name || /[\p{C}/\\]/u.test(file.name)) throw new Error("The machine returned an invalid download name.");
      const url = URL.createObjectURL(file.blob);
      const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 60_000);
      urls.current.set(url, timer);
      const link = document.createElement("a");
      link.href = url; link.download = file.name; link.rel = "noopener noreferrer"; link.hidden = true;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
    } catch (reason) {
      if (!controller.signal.aborted && active.current === controller) reportError(errorMessage(reason));
    } finally {
      if (active.current === controller) { active.current = undefined; setBusy(false); }
    }
  };
  return <div className="files-open-in">
    <button type="button" className="chrome-button" disabled={busy} onClick={() => { void download(); }}>
      <Download size={12} aria-hidden="true" /> {busy ? "Downloading…" : "Download"}
    </button>
    {error && !onError ? <span className="files-notice files-error" role="alert">{error}</span> : null}
  </div>;
}
