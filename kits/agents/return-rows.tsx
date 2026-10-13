import { Bot, ChevronRight } from "lucide-react";
import type { ToolCardProps, TranscriptRow, UiMessage } from "tau";
import { nativeAgentRow } from "./model.js";
import type { NativeAgentReport } from "./native-events.js";
import { openAgent } from "./subagent-view.js";

const OUTCOME = { completed: "finished", failed: "failed", cancelled: "was cancelled" };

/** Durable returns supplement the launch card at the point each child reported back. */
export function agentReturnRows({ tools, messages, actions }: ToolCardProps & { messages: readonly UiMessage[] }): TranscriptRow[] {
  const rows: { timestamp: number; row: TranscriptRow }[] = [];
  for (const tool of tools) {
    const agent = nativeAgentRow(tool);
    if (!agent || !Array.isArray(tool.args.reports)) continue;
    for (const value of tool.args.reports) {
      const report = value as Partial<NativeAgentReport> | undefined;
      if (!report || typeof report.id !== "string" || typeof report.timestamp !== "number" || !Number.isFinite(report.timestamp)
        || (report.status !== "completed" && report.status !== "failed" && report.status !== "cancelled")) continue;
      // Do not attach an older return to the tail of a window that has not loaded it yet.
      const timestamp = report.timestamp;
      if (!Number.isFinite(new Date(timestamp).getTime())) continue;
      const anchor = [...messages].reverse().find((message) => message.timestamp <= timestamp);
      if (!anchor) continue;
      const label = `Subagent "${agent.title}" ${OUTCOME[report.status]}`;
      rows.push({ timestamp, row: {
        id: `agents.return:${tool.id}:${report.id}`,
        afterMessageId: anchor.id,
        content: <div className={`wake-line agent-return status-${report.status}`} role="note" aria-label={label}>
          <div className="wake-line-row"><button type="button" aria-label={`${label}. Open subagent`}
            disabled={!actions.openConversationView} onClick={() => openAgent(agent, actions)}>
            <Bot size={14} aria-hidden /><span>{label}</span>
            <time dateTime={new Date(timestamp).toISOString()} title={new Date(timestamp).toLocaleString()}>
              {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </time><ChevronRight size={12} aria-hidden />
          </button></div>
        </div>,
      } });
    }
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp).map(({ row }) => row);
}
