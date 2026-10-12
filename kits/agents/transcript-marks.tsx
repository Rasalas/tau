import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { ProviderIconStack } from "tau";
import { isBusyStatus } from "./protocol.js";
import type { AgentRow } from "./model.js";

/** A child's runtime knows its maker even when its model has no provider prefix. */
export function AgentProviderMark({ row }: { row: AgentRow }) {
  const provider = row.model?.includes("/") ? row.model.slice(0, row.model.indexOf("/")) : undefined;
  return <span className="agent-provider-mark" aria-hidden="true">
    {provider || row.native?.runtime ? <ProviderIconStack modelProvider={provider} runtimeProvider={row.native?.runtime} runtimeMark={false} brand hint={false} /> : <Bot size={16} />}
  </span>;
}

/** Wall time from the first child starting until the last finishes; live while any child works. */
export function AgentTranscriptElapsed({ rows }: { rows: readonly AgentRow[] }) {
  const [now, setNow] = useState(Date.now);
  const live = rows.some((row) => isBusyStatus(row.status));
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const starts = rows.flatMap((row) => row.startedAt === undefined ? [] : [row.startedAt]);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = live ? now : Math.max(...rows.map((row) => row.endedAt ?? row.startedAt ?? start));
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const elapsed = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`
    : minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
  return <time className="agent-lineage-time agent-transcript-time">{elapsed}</time>;
}
