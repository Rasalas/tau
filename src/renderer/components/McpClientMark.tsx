import { useSyncExternalStore } from "react";
import { Cable } from "lucide-react";
import type { UiSession } from "../../shared/contracts";
import { MCP_EXECUTION_LABELS } from "../../shared/external-mcp";
import { useThreadStore } from "../workbench-context";
import { tooltipProps } from "./ui/Tooltip";

/** "Started by Claude Code · Ask before edits": the thread an MCP client on this machine started and may steer (ADR 0046). */
export function mcpClientLabel(client: NonNullable<UiSession["mcpClient"]>): string {
  return `Started by ${client.name} · ${MCP_EXECUTION_LABELS[client.ceiling]}`;
}

/** A quiet mark beside a thread's title; nothing for a thread the owner started. */
export function McpClientMark({ client }: { client: UiSession["mcpClient"] }) {
  if (!client) return null;
  const label = mcpClientLabel(client);
  return <span className="thread-machine thread-mcp-client" role="img" aria-label={label} {...tooltipProps(label)}><Cable size={12} aria-hidden /></span>;
}

/** The open thread's mark, for the thread's head. */
export function ThreadMcpClientMark({ sessionId }: { sessionId: string | undefined }) {
  const store = useThreadStore();
  const index = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <McpClientMark client={sessionId ? index.threads.find((thread) => thread.id === sessionId)?.mcpClient : undefined} />;
}
