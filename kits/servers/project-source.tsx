import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight, CornerLeftUp, Folder, LoaderCircle } from "lucide-react";
import { errorMessage } from "tau";
import type { HostExtensionClient, ProjectSourceProps } from "tau";
import {
  defaultExcluded, formatBytes, normalizeExcluded, projectFolderName, selectedTotals,
  type DraftListing, type DraftServer, type FolderInspection, type ProjectMade,
} from "./project-plan.js";
import type { SshHostsState } from "./protocol.js";
import { SYNC_PROGRESS_EVENT, SYNC_PROGRESS_TOPIC, type ScanSummary, type SyncProgress } from "./sync/protocol.js";

export interface ServerProjectSourceOptions {
  host: HostExtensionClient;
  /** Settings → Source control → New projects, when Workspace Kit is there to say. */
  baseDirectory(): string | undefined;
}

type Step =
  | { kind: "connect" }
  | { kind: "browse"; server: DraftServer; listing: DraftListing }
  | { kind: "overview"; server: DraftServer; remotePath: string; summary: ScanSummary }
  | { kind: "folder" }
  | { kind: "link"; inspection: FolderInspection; summaries: Record<string, ScanSummary | { error: string }> };

const serverName = (server: DraftServer) => ("alias" in server ? server.alias : server.address);
const count = (value: number) => value.toLocaleString("en-US");
const files = (value: number) => `${count(value)} ${value === 1 ? "file" : "files"}`;

/** Folders one level down, each with its second level; checked means it comes down. */
export function SizeOverview({ summary, excluded, onChange, disabled }: {
  summary: ScanSummary;
  excluded: readonly string[];
  onChange(excluded: string[]): void;
  disabled?: boolean;
}) {
  const top = summary.folders.filter((folder) => !folder.path.includes("/")).sort((a, b) => b.bytes - a.bytes);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(excluded.filter((path) => path.includes("/")).map((path) => path.split("/")[0]!)));
  const off = new Set(excluded);
  const rootFiles = summary.files - top.reduce((sum, folder) => sum + folder.files, 0);
  const rootBytes = summary.bytes - top.reduce((sum, folder) => sum + folder.bytes, 0);
  const toggle = (path: string) => onChange(normalizeExcluded(off.has(path) ? excluded.filter((entry) => entry !== path) : [...excluded.filter((entry) => !entry.startsWith(`${path}/`)), path]));
  const row = (path: string, label: string, fileCount: number, bytes: number, parentOff: boolean, extra?: ReactNode) => (
    <label key={path} className={`servers-size-row${off.has(path) || parentOff ? " off" : ""}`}>
      <input type="checkbox" checked={!off.has(path) && !parentOff} disabled={disabled || parentOff} onChange={() => toggle(path)} />
      {extra}
      <span className="servers-size-name">{label}</span>
      <small>{files(fileCount)}</small>
      <b>{formatBytes(bytes)}</b>
    </label>
  );
  return (
    <div className="servers-size" role="group" aria-label="Folders to download">
      {top.map((folder) => {
        const children = summary.folders.filter((child) => child.path.startsWith(`${folder.path}/`)).sort((a, b) => b.bytes - a.bytes);
        const expanded = open.has(folder.path);
        const caret = children.length ? (
          <button type="button" className={`servers-size-caret${expanded ? " open" : ""}`} aria-label={`${expanded ? "Hide" : "Show"} folders in ${folder.path}`}
            onClick={(event) => { event.preventDefault(); setOpen((current) => { const next = new Set(current); if (next.has(folder.path)) next.delete(folder.path); else next.add(folder.path); return next; }); }}>
            <ChevronRight size={12} />
          </button>
        ) : <span className="servers-size-caret" />;
        return (
          <div key={folder.path}>
            {row(folder.path, `${folder.path}/`, folder.files, folder.bytes, false, caret)}
            {expanded ? <div className="servers-size-children">
              {children.map((child) => row(child.path, `${child.path.slice(folder.path.length + 1)}/`, child.files, child.bytes, off.has(folder.path), <span className="servers-size-caret" />))}
            </div> : null}
          </div>
        );
      })}
      {rootFiles > 0 ? <div className="servers-size-row fixed"><span /><span className="servers-size-caret" /><span className="servers-size-name">Files at the top</span><small>{files(rootFiles)}</small><b>{formatBytes(rootBytes)}</b></div> : null}
      {top.length === 0 && rootFiles === 0 ? <p className="servers-source-note">The folder is empty.</p> : null}
    </div>
  );
}

function Totals({ summary, excluded, into }: { summary: ScanSummary; excluded: readonly string[]; into: string }) {
  const totals = selectedTotals(summary, excluded);
  const left = normalizeExcluded(excluded);
  return <p className="servers-source-note">
    {count(totals.files)} files · {formatBytes(totals.bytes)} {into}.
    {left.length ? <> Left on the server and written to {left.length === 1 ? "its" : "their"} ignore list: {left.map((path) => `${path}/`).join(", ")}.</> : null}
    {summary.skipped ? <> {count(summary.skipped)} links are not copied.</> : null}
  </p>;
}

function useProgress(host: HostExtensionClient, active: boolean): SyncProgress | undefined {
  const [progress, setProgress] = useState<SyncProgress>();
  useEffect(() => {
    if (!active) { setProgress(undefined); return; }
    const unwatch = host.watch?.(SYNC_PROGRESS_TOPIC);
    const stop = host.onEvent(SYNC_PROGRESS_EVENT, (payload) => setProgress(payload as SyncProgress));
    return () => { stop(); unwatch?.(); };
  }, [host, active]);
  return progress;
}

function progressWords(progress: SyncProgress | undefined, fallback: string): string {
  if (!progress) return fallback;
  if (progress.phase === "fetch" && progress.total) return `Downloading ${count(progress.done)} of ${count(progress.total)} files…`;
  if (progress.phase === "list") return `Listing the server (${count(progress.done)} files)…`;
  if (progress.phase === "record" || progress.phase === "done") return "Making the first commit…";
  return fallback;
}

/**
 * „From a server…“: an ssh host or an address, a folder on it, the size
 * overview and a new local folder; or a local folder with an sftp.json that
 * gets Git. The host half does the work; this view only asks.
 */
export function createServerProjectSource({ host, baseDirectory }: ServerProjectSourceOptions) {
  return function ServerProjectSource({ actions, onBack, onDone }: ProjectSourceProps) {
    const [step, setStep] = useState<Step>({ kind: "connect" });
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();
    const [via, setVia] = useState<"alias" | "address">("alias");
    const [hosts, setHosts] = useState<SshHostsState>();
    const [alias, setAlias] = useState("");
    const [address, setAddress] = useState("");
    const [jump, setJump] = useState("");
    const [excluded, setExcluded] = useState<string[]>([]);
    const [linkExcluded, setLinkExcluded] = useState<Record<string, string[]>>({});
    const base = baseDirectory()?.replace(/[\\/]+$/u, "") ?? "~";
    const [parent, setParent] = useState(base);
    const [name, setName] = useState("");
    const [folder, setFolder] = useState(`${base}/`);
    const [download, setDownload] = useState(false);
    const progress = useProgress(host, busy === "create" || busy === "link");

    useEffect(() => {
      host.invoke("ssh-hosts").then((state) => {
        const found = state as SshHostsState;
        setHosts(found);
        setAlias((current) => current || found.hosts[0] || "");
        if (found.hosts.length === 0) setVia("address");
      }, (failure: unknown) => { setHosts({ configPath: "", hosts: [], problems: [errorMessage(failure)] }); setVia("address"); });
      // The connections made while choosing end with this view.
      return () => { void host.invoke("draft-close").catch(() => undefined); };
    }, []);

    const run = async <T,>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
      setBusy(label);
      setError(undefined);
      try {
        return await work();
      } catch (failure) {
        setError(errorMessage(failure));
        return undefined;
      } finally {
        setBusy(undefined);
      }
    };

    const server: DraftServer = via === "alias" ? { alias } : { address: address.trim() };
    const browse = (target: DraftServer, path?: string) => run("browse", async () => {
      const listing = await host.invoke("draft-browse", { server: target, ...(path ? { path } : {}) }) as DraftListing;
      setJump(listing.path);
      setStep({ kind: "browse", server: target, listing });
    });
    const scan = (target: DraftServer, remotePath: string) => run("scan", async () => {
      const summary = await host.invoke("draft-scan", { server: target, remotePath }) as ScanSummary;
      setExcluded(defaultExcluded(summary.folders));
      setName(projectFolderName(remotePath, serverName(target)));
      setStep({ kind: "overview", server: target, remotePath, summary });
    });
    const opened = async (made: ProjectMade, what: string) => {
      onDone();
      actions.notify(`${what}: ${count(made.files)} files in the first commit on ${made.branch}.`);
      if (!await actions.openWorkspace(made.workspaceId)) actions.notify("The project could not be opened.");
    };
    const create = (target: DraftServer, remotePath: string) => run("create", async () => {
      const made = await host.invoke("create-project", { server: target, remotePath, parent: parent.trim(), name: name.trim(), exclude: excluded }) as ProjectMade;
      await opened(made, `Made ${made.path.split(/[\\/]/u).at(-1)} from ${serverName(target)}`);
    });
    const inspect = () => run("inspect", async () => {
      const inspection = await host.invoke("inspect-folder", { path: folder.trim() }) as FolderInspection;
      setDownload(inspection.empty);
      setStep({ kind: "link", inspection, summaries: {} });
      if (inspection.hasGit) return;
      const summaries: Record<string, ScanSummary | { error: string }> = {};
      const defaults: Record<string, string[]> = {};
      for (const target of inspection.targets.filter((entry) => entry.usable)) {
        try {
          const summary = await host.invoke("link-scan", { path: inspection.path, targetId: target.id }) as ScanSummary;
          summaries[target.id] = summary;
          defaults[target.id] = defaultExcluded(summary.folders);
        } catch (failure) {
          summaries[target.id] = { error: errorMessage(failure) };
        }
      }
      setLinkExcluded(defaults);
      setStep({ kind: "link", inspection, summaries });
    });
    const link = (inspection: FolderInspection) => run("link", async () => {
      const made = await host.invoke("link-folder", { path: inspection.path, exclude: linkExcluded, download }) as ProjectMade;
      await opened(made, `Git for ${made.path.split(/[\\/]/u).at(-1)}`);
    });

    const submit = (event: FormEvent, action: () => void) => { event.preventDefault(); if (!busy) action(); };
    const errorLine = error ? <p className="servers-source-error" role="alert">{error}</p> : null;
    const spinner = (label: string) => (busy === label ? <LoaderCircle size={13} className="servers-source-spin" aria-hidden="true" /> : null);

    if (step.kind === "connect" || step.kind === "folder") {
      const tabs = (
        <div className="servers-source-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={step.kind === "connect"} className={step.kind === "connect" ? "active" : ""} onClick={() => { setError(undefined); setStep({ kind: "connect" }); }}>Server</button>
          <button type="button" role="tab" aria-selected={step.kind === "folder"} className={step.kind === "folder" ? "active" : ""} onClick={() => { setError(undefined); setStep({ kind: "folder" }); }}>Folder with sftp.json</button>
        </div>
      );
      if (step.kind === "folder") {
        return (
          <form className="servers-source" onSubmit={(event) => submit(event, () => void inspect())}>
            {tabs}
            <label>
              <span>Local folder</span>
              <input autoFocus value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="~/Sites/shop" disabled={Boolean(busy)} />
              <small>A folder with <code>.vscode/sftp.json</code> and no Git. Tau reads its servers, makes a repository whose first commit is the server's state and leaves the files as they are, so Git shows where they differ.</small>
            </label>
            {errorLine}
            <div className="servers-source-actions">
              <button type="button" onClick={onBack} disabled={Boolean(busy)}>Back</button>
              <button type="submit" className="primary" disabled={Boolean(busy) || !folder.trim()}>{spinner("inspect")}Read sftp.json</button>
            </div>
          </form>
        );
      }
      const ready = via === "alias" ? Boolean(alias) : Boolean(address.trim());
      return (
        <form className="servers-source" onSubmit={(event) => submit(event, () => void browse(server))}>
          {tabs}
          <div className="servers-source-choice" role="radiogroup" aria-label="Server from">
            <label><input type="radio" checked={via === "alias"} onChange={() => setVia("alias")} disabled={Boolean(busy) || !hosts?.hosts.length} />SSH host</label>
            <label><input type="radio" checked={via === "address"} onChange={() => setVia("address")} disabled={Boolean(busy)} />Address</label>
          </div>
          {via === "alias" ? (
            <label>
              <span>Host from the SSH config</span>
              <select value={alias} onChange={(event) => setAlias(event.target.value)} disabled={Boolean(busy) || !hosts}>
                {hosts?.hosts.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </select>
              <small>{hosts ? `From ${hosts.configPath}` : "Reading the SSH config…"}</small>
            </label>
          ) : (
            <label>
              <span>Address</span>
              <input autoFocus value={address} onChange={(event) => setAddress(event.target.value)} placeholder="deploy@example.com:22" disabled={Boolean(busy)} />
              <small>SSH only for now: <code>user@host</code>, <code>user@host:port</code> or <code>sftp://user@host:port</code>. A password is asked when the server wants one and never written to the project.</small>
            </label>
          )}
          {hosts?.problems.length && via === "alias" ? <p className="servers-source-note">{hosts.problems.join(" ")}</p> : null}
          {errorLine}
          <div className="servers-source-actions">
            <button type="button" onClick={onBack} disabled={Boolean(busy)}>Back</button>
            <button type="submit" className="primary" disabled={Boolean(busy) || !ready}>{spinner("browse")}Connect</button>
          </div>
        </form>
      );
    }

    if (step.kind === "browse") {
      const { listing } = step;
      return (
        <div className="servers-source">
          <form className="servers-source-path" onSubmit={(event) => submit(event, () => void browse(step.server, jump.trim()))}>
            <button type="button" aria-label="Up one folder" disabled={Boolean(busy) || !listing.parent} onClick={() => void browse(step.server, listing.parent)}><CornerLeftUp size={14} /></button>
            <input value={jump} onChange={(event) => setJump(event.target.value)} aria-label="Folder on the server" disabled={Boolean(busy)} />
            <button type="submit" disabled={Boolean(busy)}>Go</button>
          </form>
          <div className="servers-source-list" role="list" aria-label={`Folders in ${listing.path}`}>
            {listing.directories.map((directory) => (
              <button type="button" role="listitem" key={directory.path} disabled={Boolean(busy)} onClick={() => void browse(step.server, directory.path)}>
                <Folder size={15} /><span>{directory.name}</span>
              </button>
            ))}
            {listing.directories.length === 0 ? <p className="servers-source-note">No folders here{listing.files ? `, ${count(listing.files)} files` : ""}.</p> : null}
          </div>
          <p className="servers-source-note">{serverName(step.server)} · <code>{listing.path}</code>{listing.files ? ` · ${count(listing.files)} files here` : ""}</p>
          {errorLine}
          <div className="servers-source-actions">
            <button type="button" onClick={() => setStep({ kind: "connect" })} disabled={Boolean(busy)}>Back</button>
            <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void scan(step.server, listing.path)}>{spinner("scan")}Use this folder</button>
          </div>
        </div>
      );
    }

    if (step.kind === "overview") {
      const destination = `${parent.replace(/[\\/]+$/u, "")}/${name}`;
      return (
        <form className="servers-source" onSubmit={(event) => submit(event, () => void create(step.server, step.remotePath))}>
          <p className="servers-source-note"><strong>{serverName(step.server)}</strong> · <code>{step.remotePath}</code></p>
          <SizeOverview summary={step.summary} excluded={excluded} onChange={setExcluded} disabled={Boolean(busy)} />
          <Totals summary={step.summary} excluded={excluded} into="come down" />
          <div className="servers-source-row">
            <label>
              <span>Parent folder</span>
              <input value={parent} onChange={(event) => setParent(event.target.value)} disabled={Boolean(busy)} aria-label="Parent folder" />
            </label>
            <label>
              <span>New folder</span>
              <input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(busy)} aria-label="New folder" />
            </label>
          </div>
          <p className="servers-source-note">Tau makes <code title={destination}>{destination}</code>, writes <code>.vscode/sftp.json</code> without a password, downloads the files and commits them as the server's state. Nothing is written to the server.</p>
          {busy === "create" ? <p className="servers-source-note" aria-live="polite">{progressWords(progress, "Connecting…")}</p> : null}
          {errorLine}
          <div className="servers-source-actions">
            <button type="button" onClick={() => void browse(step.server, step.remotePath)} disabled={Boolean(busy)}>Back</button>
            <button type="submit" className="primary" disabled={Boolean(busy) || !name.trim() || !parent.trim()}>{spinner("create")}Create project</button>
          </div>
        </form>
      );
    }

    const { inspection, summaries } = step;
    const reachable = inspection.targets.filter((target) => target.usable);
    const blocked = inspection.targets.length === 0 || reachable.length !== inspection.targets.length;
    const scanned = reachable.every((target) => summaries[target.id] && !("error" in summaries[target.id]!));
    return (
      <form className="servers-source" onSubmit={(event) => submit(event, () => void link(inspection))}>
        <p className="servers-source-note"><code>{inspection.path}</code></p>
        {inspection.hasGit ? (
          <p className="servers-source-note">This folder has Git already. Open it as a project; Tau reads its sftp.json from there.</p>
        ) : null}
        {inspection.issues.map((issue, index) => <p key={index} className="servers-source-note">{issue.message}</p>)}
        {!inspection.hasGit ? inspection.targets.map((target) => {
          const summary = summaries[target.id];
          return (
            <section key={target.id} className="servers-source-target">
              <h3>{target.label} <small>{target.host}:{target.remotePath}{target.context ? ` → ${target.context}/` : ""}</small></h3>
              {!target.usable
                ? <p className="servers-source-note">{target.issues.map((issue) => issue.message).join(" ")}</p>
                : !summary ? <p className="servers-source-note">{spinner("inspect")}Sizing the server folder…</p>
                  : "error" in summary ? <p className="servers-source-error">{summary.error}</p>
                    : <>
                      <SizeOverview summary={summary} excluded={linkExcluded[target.id] ?? []} onChange={(next) => setLinkExcluded((current) => ({ ...current, [target.id]: next }))} disabled={Boolean(busy)} />
                      <Totals summary={summary} excluded={linkExcluded[target.id] ?? []} into={download ? "come down where the folder lacks them" : "go into the first commit"} />
                    </>}
            </section>
          );
        }) : null}
        {!inspection.hasGit ? (
          <label className="servers-source-check">
            <input type="checkbox" checked={download} onChange={(event) => setDownload(event.target.checked)} disabled={Boolean(busy)} />
            <span>Also download what the folder lacks. Files that differ stay as they are either way.</span>
          </label>
        ) : null}
        {busy === "link" ? <p className="servers-source-note" aria-live="polite">{progressWords(progress, "Reading the server…")}</p> : null}
        {errorLine}
        <div className="servers-source-actions">
          <button type="button" onClick={() => setStep({ kind: "folder" })} disabled={Boolean(busy)}>Back</button>
          {inspection.hasGit
            ? <button type="button" className="primary" onClick={() => void actions.openWorkspace(inspection.path).then((ok) => { if (ok) onDone(); })}>Open project</button>
            : <button type="submit" className="primary" disabled={Boolean(busy) || blocked || !scanned}>{spinner("link")}Create Git repository</button>}
        </div>
      </form>
    );
  };
}

