import { useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, ArrowUp } from "lucide-react";
import { errorMessage, useCommandAllowed, type HostExtensionClient, type WorkbenchActions } from "tau";
import type { ServerFolderListing } from "./folder-protocol.js";
import { openTarget } from "./status-parts.js";
import { SERVER_TARGET_TAB, type TargetStatus } from "./view-protocol.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";

const remoteFolder = ({ root, path }: ServerFolderListing) => path ? `${root.replace(/\/$/u, "")}/${path}` : root;

/** A directory browser, not a file index: each navigation reads exactly one directory. */
export function ServerFolderPicker({ host, cwd, target, actions, onClose }: { host: HostExtensionClient; cwd: string; target: TargetStatus; actions: WorkbenchActions; onClose(): void }) {
  const canAuthorize = useCommandAllowed(SERVERS_EXTENSION_ID, "authorize-server");
  const canMap = useCommandAllowed(SERVERS_EXTENSION_ID, "set-server-folders");
  const [listing, setListing] = useState<ServerFolderListing>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [offerSearch, setOfferSearch] = useState(false);
  const [candidates, setCandidates] = useState<ServerFolderListing[]>();
  const [remotePath, setRemotePath] = useState(target.remotePath ?? "");
  const [context, setContext] = useState(target.context);
  const operation = useRef<string | undefined>(undefined);
  const stop = () => {
    const operationId = operation.current;
    operation.current = undefined;
    if (operationId) void host.invoke("cancel-server-operation", { cwd, targetId: target.targetId, operationId }).catch(() => undefined);
    setBusy(false);
  };
  const browse = async (path: string) => {
    stop();
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setBusy(true); setError(undefined); setCandidates(undefined);
    try {
      if (target.connectionFingerprint && canAuthorize) await host.invoke("authorize-server", { cwd, targetId: target.targetId, fingerprint: target.connectionFingerprint });
      if (operation.current !== operationId) return;
      const next = await host.invoke("server-folder", { cwd, targetId: target.targetId, path, operationId }) as ServerFolderListing;
      if (operation.current !== operationId) return;
      setListing(next);
      setRemotePath(remoteFolder(next));
    } catch (failure) { if (operation.current === operationId) setError(errorMessage(failure)); }
    finally { if (operation.current === operationId) { operation.current = undefined; setBusy(false); } }
  };
  useEffect(() => { void browse(""); return () => { const operationId = operation.current; if (operationId) void host.invoke("cancel-server-operation", { cwd, targetId: target.targetId, operationId }).catch(() => undefined); }; }, [cwd, target.targetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async () => {
    const operationId = crypto.randomUUID(); operation.current = operationId;
    setBusy(true); setOfferSearch(false); setError(undefined);
    try {
      const found = await host.invoke("find-server-folder", { cwd, targetId: target.targetId, path: listing?.path ?? "", operationId }) as { candidates: ServerFolderListing[] };
      if (operation.current === operationId) setCandidates(found.candidates);
    } catch (failure) { if (operation.current === operationId) setError(errorMessage(failure)); }
    finally { if (operation.current === operationId) { operation.current = undefined; setBusy(false); } }
  };
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await host.invoke("set-server-folders", { cwd, targetId: target.targetId, remotePath, context }) as { targetId: string };
      onClose();
      if (result.targetId !== target.targetId) {
        for (const tab of actions.stageTabs()) {
          if (tab.kind === "extension" && tab.tabKind === SERVER_TARGET_TAB && tab.params.workspace === cwd && tab.params.targetId === target.targetId) actions.closeStageTab(tab.id);
        }
      }
      openTarget(actions, cwd, result.targetId);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  return <section className="servers-folder-picker" aria-label="Choose server folder">
    <header className="servers-upload-head"><h2>Project and server folders</h2><button type="button" className="text-button" onClick={() => { stop(); onClose(); }}>Cancel</button></header>
    <p className="servers-group-note">Opening a folder reads only its direct entries. Files are not downloaded.</p>
    {error ? <p className="servers-error" role="alert">{error}</p> : null}
    <div className="servers-folder-path"><code>{listing ? [listing.root, listing.path].filter(Boolean).join("/").replace(/\/{2,}/gu, "/") : target.remotePath}</code>
      {listing?.path ? <button type="button" className="text-button" disabled={busy} onClick={() => void browse(listing.path.split("/").slice(0, -1).join("/"))}><ArrowUp size={13} />Up</button> : null}</div>
    <ul className="servers-folder-entries" aria-label="Server folder entries">
      {listing?.entries.map((entry) => <li key={entry.name}>{entry.directory ? <button type="button" disabled={busy} onClick={() => void browse([listing.path, entry.name].filter(Boolean).join("/"))}><Folder size={14} /><span>{entry.name}</span><ChevronRight size={13} /></button> : <span className="servers-folder-file">{entry.name}</span>}</li>)}
    </ul>
    {listing ? <p className="servers-group-note">{listing.matches} of {listing.localItems} local names also appear here. This is a hint about the folder, not a content comparison.</p> : null}
    {busy ? <p role="status">Reading folders… <button type="button" className="text-button" onClick={stop}>Stop</button></p> : null}
    {candidates ? <div className="servers-folder-candidates"><h3>Possible folders</h3>{candidates.length ? candidates.map((candidate) => <button key={candidate.path} type="button" className="text-button" onClick={() => { setListing(candidate); setRemotePath(remoteFolder(candidate)); setCandidates(undefined); }}><code>{candidate.path || "."}</code><span>{candidate.matches} matching names</span></button>) : <p>No matching folder found in the search area.</p>}</div> : null}
    <label className="servers-folder-field">Local folder inside this project<input aria-label="Local folder inside this project" placeholder="The project folder" value={context} onChange={(event) => setContext(event.target.value)} /></label>
    <label className="servers-folder-field">Server folder<input aria-label="Server folder" value={remotePath} onChange={(event) => setRemotePath(event.target.value)} /></label>
    <div className="servers-folder-footer"><button type="button" className="chrome-button primary" disabled={busy || !canMap || !remotePath.trim()} onClick={() => void save()}>Use these folders</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => { setOfferSearch(true); }}>Find a matching folder…</button></div>
    {offerSearch ? <div className="servers-banner" role="group" aria-label="Search server folders"><span>Search up to 2 levels below this folder, at most 64 folders. Reads directory names only.</span><button type="button" className="text-button" onClick={() => void search()}>Search</button><button type="button" className="text-button" onClick={() => setOfferSearch(false)}>Cancel</button></div> : null}
  </section>;
}
