import { Bot, Brain, ChevronRight, EyeOff } from "lucide-react";
import { memo, useContext, useState } from "react";
import { WorkbenchShellContext } from "../workbench-context";
import { LazyFeatureBoundary } from "./LazyFeature";
import { splitMessageBlocks } from "./message-blocks";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptDetail } from "../../workbench/transcript-folding";
import { MessageActions } from "./MessageActions";
import { UserMessage } from "./UserMessage";
import { Markdown } from "./Markdown";
import { compactTimestamp, fullTimestamp } from "./message-timestamp";

interface AsyncActivity {
  label: string;
  detail: string;
  attention?: boolean;
}

export function parseAsyncActivity(text: string): AsyncActivity | undefined {
  if (text.startsWith("Subagent needs attention:")) {
    return { label: "Subagent needs attention", detail: text, attention: true };
  }
  if (!text.startsWith("Background task completed:")) return undefined;

  const count = /completed with (\d+) child run\(s\)/i.exec(text)?.[1];
  const label = count
    ? `${count} subagent ${count === "1" ? "run" : "runs"} completed`
    : "Background task completed";
  return { label, detail: text };
}

/**
 * Thinking as one row before the answer, as T3 Code draws it: folded in a
 * focused transcript, open from detailed on. `onToggle` lets the transcript
 * keep the reader's choice when the row is recycled.
 */
function ThinkingDisclosure({ thinking, streaming, open, onToggle }: { thinking: string; streaming?: boolean; open: boolean; onToggle(open: boolean): void }) {
  return (
    <details className="message-thinking" open={open} onToggle={(event) => { const next = (event.target as HTMLDetailsElement).open; if (next !== open) onToggle(next); }}>
      <summary><Brain size={14} strokeWidth={1.8} /><span>{streaming ? "Thinking…" : "Thought"}</span><ChevronRight size={12} className="chev" /></summary>
      {open ? <div className="message-thinking-body"><Markdown streaming={streaming}>{thinking}</Markdown></div> : null}
    </details>
  );
}

function ActivityDisclosure({ activity }: { activity: AsyncActivity }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`activity-disclosure${activity.attention ? " attention" : ""}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Bot size={16} strokeWidth={1.7} />
        <span>{activity.label}</span>
        <ChevronRight className="activity-chevron" size={14} />
      </button>
      {open ? <pre>{activity.detail}</pre> : null}
    </section>
  );
}

/** A reply whose tagged blocks an extension draws itself; the rest stays Markdown. */
function AssistantText({ message, streaming }: { message: UiMessage; streaming: boolean }) {
  const registry = useContext(WorkbenchShellContext)?.registry;
  const blocks = registry?.getMessageBlocks() ?? [];
  const parts = splitMessageBlocks(message.text, blocks.map((block) => block.tag));
  if (parts.length === 1 && parts[0]!.kind === "text") return <Markdown streaming={streaming}>{message.text}</Markdown>;
  return <>{parts.map((part, index) => {
    if (part.kind === "text") return <Markdown key={index} streaming={streaming && index === parts.length - 1}>{part.text}</Markdown>;
    const block = blocks.find((entry) => entry.tag === part.tag)!;
    return <LazyFeatureBoundary key={index} label={block.id} extensionId={block.extensionId} extensionName={block.extensionName} registry={registry}>
      <block.Component body={part.body} complete={part.complete} message={message} streaming={streaming} />
    </LazyFeatureBoundary>;
  })}</>;
}

export const Message = memo(function Message({
  message,
  streaming = false,
  detail = "focused",
  onCopy,
  onFork,
  onEdit,
  onToggleExpanded,
  expanded,
}: {
  message: UiMessage;
  streaming?: boolean;
  /** How much of the turn this transcript shows; `focused` folds thinking into one row. */
  detail?: TranscriptDetail;
  onCopy?: (message: UiMessage) => void;
  onFork?: (message: UiMessage) => void;
  /** Rewinds to before a prompt of the user's and puts it back into the composer. */
  onEdit?: (message: UiMessage) => void;
  onToggleExpanded?: (messageId: string, expanded: boolean) => void;
  expanded?: boolean;
}) {
  // Host-resolved skill metadata is authoritative; do not let the generic
  // activity heuristic replace a typed skill message.
  const activity = message.skill ? undefined : parseAsyncActivity(message.text);
  const [thinkingToggled, setThinkingToggled] = useState(false);

  if (activity) return <ActivityDisclosure activity={activity} />;
  if (message.role === "notice") return <div className="notice-message">{message.text}</div>;

  if (message.role === "user") {
    return <UserMessage message={message} onCopy={onCopy} onFork={onFork} onEdit={onEdit} onToggleExpanded={onToggleExpanded} expanded={expanded} />;
  }

  const thinking = message.thinking?.trim() ? message.thinking : undefined;
  if (!message.text && !thinking) return null;
  const thinkingOpenByDefault = detail !== "focused";
  // For assistant rows `expanded` means the reader flipped the thinking row away from its default.
  const flipped = onToggleExpanded ? Boolean(expanded) : thinkingToggled;
  const thinkingOpen = flipped ? !thinkingOpenByDefault : thinkingOpenByDefault;
  const toggleThinking = (open: boolean) => {
    const next = open !== thinkingOpenByDefault;
    if (onToggleExpanded) onToggleExpanded(message.id, next);
    else setThinkingToggled(next);
  };

  return (
    <div className={`message-shell assistant${message.excludedFromContext ? " excluded-from-context" : ""}`}>
      <article className="message assistant">
        {message.excludedFromContext ? (
          <div className="message-context-badge" title="Executed locally; excluded from model context">
            <EyeOff size={12} strokeWidth={1.7} />
            <span>Not in model context</span>
          </div>
        ) : null}
        {thinking ? <ThinkingDisclosure thinking={thinking} streaming={streaming && !message.text} open={thinkingOpen} onToggle={toggleThinking} /> : null}
        {message.text ? (
          <div className="message-text">
            {message.text.includes("<") ? <AssistantText message={message} streaming={streaming} /> : <Markdown streaming={streaming}>{message.text}</Markdown>}
          </div>
        ) : null}
        {detail === "everything" && message.text ? (
          <time className="message-stamp" dateTime={new Date(message.timestamp).toISOString()} title={fullTimestamp(message.timestamp)}>
            {compactTimestamp(message.timestamp)}
          </time>
        ) : null}
      </article>
      {onCopy ? <MessageActions
        message={message}
        onCopy={() => onCopy(message)}
        onFork={message.sourceEntryId && onFork ? () => onFork(message) : undefined}
      /> : null}
    </div>
  );
});
