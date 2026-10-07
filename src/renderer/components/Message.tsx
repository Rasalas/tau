import { Bot, Brain, ChevronRight, EyeOff } from "lucide-react";
import { memo, useState } from "react";
import { LazyFeatureBoundary } from "./LazyFeature";
import { splitMessageBlocks } from "./message-blocks";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptDetail } from "../../workbench/transcript-folding";
import { MessageActions } from "./MessageActions";
import { UserMessage, useMessageBlocks } from "./UserMessage";
import { Markdown } from "./LazyMarkdown";
import { compactTimestamp, fullTimestamp } from "./message-timestamp";
import { TurnErrorLine } from "./TurnError";
import { CompactionDivider } from "./CompactionDivider";
import { WakeLine } from "./WakeLine";
import { parseAsyncActivity, type AsyncActivity } from "./MessageText";
import type { RetriedError } from "../../workbench/transcript-state";
import type { TranscriptTurn } from "../extension-system";

/**
 * Thinking as one row before the answer: folded in a
 * focused transcript, open from detailed on. `onToggle` lets the transcript
 * keep the reader's choice when the row is recycled.
 */
function ThinkingDisclosure({ thinking, streaming, open, onToggle }: { thinking: string; streaming?: boolean; open: boolean; onToggle(open: boolean): void }) {
  return (
    <details className="message-thinking" open={open} onToggle={(event) => { const next = (event.target as HTMLDetailsElement).open; if (next !== open) onToggle(next); }}>
      <summary><Brain size={14} strokeWidth={1.8} /><span className={streaming ? "work-shine" : ""}>{streaming ? "Thinking" : "Thought"}</span><ChevronRight size={12} className="chev" /></summary>
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
  const { registry, blocks } = useMessageBlocks("assistant", true);
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
  onEdit,
  onRetry,
  retried,
  onToggleExpanded,
  expanded,
  turn,
}: {
  message: UiMessage;
  streaming?: boolean;
  /** How much of the turn this transcript shows; `focused` folds thinking into one row. */
  detail?: TranscriptDetail;
  onCopy?: (message: UiMessage) => void;
  /** The turn a prompt starts, for its divider. */
  turn?: TranscriptTurn;
  /** Rewinds to before a prompt of the user's and puts it back into the composer. */
  onEdit?: (message: UiMessage) => void;
  /** Sends the prompt that led to this failed answer again. */
  onRetry?: (message: UiMessage) => void;
  /** Set when this failed answer stands for a run of automatic retries. */
  retried?: RetriedError;
  onToggleExpanded?: (messageId: string, expanded: boolean) => void;
  expanded?: boolean;
}) {
  // Host-resolved skill metadata is authoritative; do not let the generic
  // activity heuristic replace a typed skill message.
  const activity = message.skill ? undefined : parseAsyncActivity(message.text);
  const [thinkingToggled, setThinkingToggled] = useState(false);

  if (activity?.wake) return <WakeLine wake={activity.wake} detail={activity.detail} timestamp={message.timestamp} />;
  if (activity) return <ActivityDisclosure activity={activity} />;
  if (message.compaction) return <CompactionDivider compaction={message.compaction} />;
  if (message.role === "notice") return <div className="notice-message">{message.text}</div>;

  if (message.role === "user") {
    return <UserMessage message={message} onCopy={onCopy} onEdit={onEdit} onToggleExpanded={onToggleExpanded} expanded={expanded} turn={turn} />;
  }

  const thinking = message.thinking?.trim() ? message.thinking : undefined;
  if (!message.text && !thinking && !message.error) return null;
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
        {message.error ? <TurnErrorLine message={message.error} retries={retried?.retries} recovered={retried?.recovered} onRetry={onRetry ? () => onRetry(message) : undefined} /> : null}
        {detail === "everything" && message.text ? (
          <time className="message-stamp" dateTime={new Date(message.timestamp).toISOString()} title={fullTimestamp(message.timestamp)}>
            {compactTimestamp(message.timestamp)}
          </time>
        ) : null}
      </article>
      {onCopy && (message.text || !message.error) ? <MessageActions
        message={message}
        onCopy={() => onCopy(message)}
      /> : null}
    </div>
  );
});
