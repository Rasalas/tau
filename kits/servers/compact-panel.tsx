import { useState } from "react";
import { AlertTriangle, Server } from "lucide-react";
import { Empty, Skeleton, errorMessage, useCommandAllowed, type PanelProps } from "tau";
import { useThreadCwd } from "./compact-glyph.js";
import { useServersStatus } from "./status-parts.js";
import { HistoryPanel } from "./history-panel.js";
import { FileDiff, type ServerViewParts } from "./server-view.js";
import { UploadPanel } from "./upload-panel.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import type { ServerDiffSource, TargetStatus } from "./view-protocol.js";

function CompactDiff({ parts, cwd, targetId, source }: { parts: ServerViewParts; cwd: string; targetId: string; source: ServerDiffSource }) {
  return <div className="servers-compact-diff"><FileDiff key={JSON.stringify(source)} host={parts.host} cwd={cwd} targetId={targetId} source={source} onChanged={() => void parts.store.load(cwd, true)} /></div>;
}

function CompactTarget({ parts, cwd, target, actions }: { parts: ServerViewParts; cwd: string; target: TargetStatus; actions: PanelProps["actions"] }) {
  const canAuthorize = useCommandAllowed(SERVERS_EXTENSION_ID, "authorize-server");
  const [history, setHistory] = useState(false);
  const [diff, setDiff] = useState<ServerDiffSource>();
  const inspect = async (path: string) => {
    try {
      if (target.connectionFingerprint && canAuthorize) await parts.host.invoke("authorize-server", { cwd, targetId: target.targetId, fingerprint: target.connectionFingerprint });
      setDiff({ source: "pending", path });
    } catch (failure) { actions.notify(errorMessage(failure), "error"); }
  };
  const shown = diff ? <CompactDiff parts={parts} cwd={cwd} targetId={target.targetId} source={diff} /> : null;
  return <section className="servers-compact-target" aria-label={`Server ${target.label}`}>
    <header className="servers-compact-head"><Server size={16} /><h2>{target.label}</h2><button type="button" className="text-button" onClick={() => setHistory(!history)}>{history ? "Upload" : "History"}</button></header>
    <p className="servers-compact-meta"><code>{target.address}</code></p>
    {target.error ? <p className="servers-error" role="alert">{target.error}</p> : null}
    {target.state === "incomplete" ? <p className="servers-banner warn" role="status">An upload was interrupted. Review it in History before uploading again.</p> : null}
    {history ? <HistoryPanel stacked parts={parts} actions={actions} cwd={cwd} target={target} active={diff?.source === "history" ? diff : undefined} onFile={(entry, path) => setDiff({ source: "history", commit: entry.commit, path })} main={diff?.source === "history" ? shown : null} /> : <><UploadPanel parts={parts} actions={actions} cwd={cwd} target={target} active={diff?.source === "pending" ? diff.path : undefined} onOpen={(path) => void inspect(path)} />{diff?.source === "pending" ? shown : null}</>}
  </section>;
}

/**
 * A phone's or tablet's servers: status, upload, history and rollback, with
 * touch-sized targets. Upload and rollback show their preview first and write
 * only on its button; a Read-only device sees them disabled with the reason.
 */
export function createCompactPanel(parts: ServerViewParts) {
  return function ServersSheet({ actions }: PanelProps) {
    const cwd = useThreadCwd();
    const entry = useServersStatus(parts.store, cwd, { fresh: true });
    if (!cwd) return <Empty icon={<Server size={18} />} title="No project open" description="Open a thread in a project to see its servers." />;
    if (entry.error && !entry.status) return <Empty icon={<AlertTriangle size={18} />} title="Could not read the server status" description={entry.error} />;
    if (!entry.status) return <div className="servers-compact" aria-busy="true"><Skeleton shape="card" /></div>;
    if (entry.status.targets.length === 0) return <Empty icon={<Server size={18} />} title="No servers" description="This project's .vscode/sftp.json names no server." />;
    return (
      <div className="servers-compact">
        <p className="servers-upload-source">Upload from <strong>{entry.status?.branch ?? "project files"}</strong></p>
        {entry.status.targets.map((target) => <CompactTarget key={`${target.targetId}:${entry.status?.branch ?? ""}:${entry.status?.head ?? ""}`} parts={parts} cwd={cwd} target={target} actions={actions} />)}
      </div>
    );
  };
}
