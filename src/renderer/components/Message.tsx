import { Bot, ChevronRight } from "lucide-react";
import { memo, useState, useSyncExternalStore } from "react";
import type { UiMessage } from "../../shared/contracts";
import { MessageActions } from "./MessageActions";
import { UserMessage } from "./UserMessage";
import { Markdown } from "./Markdown";
import { preferences } from "../preferences";

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

const readShowThinking = () => preferences.getSnapshot().showThinking;

/** Pi shows thinking as a collapsible block; Ctrl+T there is the palette command here. */
function ThinkingDisclosure({ thinking, streaming }: { thinking: string; streaming?: boolean }) {
  const expandedByDefault = useSyncExternalStore(preferences.subscribe, readShowThinking, readShowThinking);
  const [toggled, setToggled] = useState<boolean>();
  const open = toggled ?? expandedByDefault;
  return (
    <details className="message-thinking" open={open} onToggle={(event) => setToggled((event.target as HTMLDetailsElement).open)}>
      <summary><ChevronRight size={12} className="chev" /> Thinking{streaming && !thinking.trim() ? "…" : ""}</summary>
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

export const Message = memo(function Message({
  message,
  streaming = false,
  onCopy,
  onFork,
  onToggleExpanded,
  expanded,
}: {
  message: UiMessage;
  streaming?: boolean;
  onCopy?: (message: UiMessage) => void;
  onFork?: (message: UiMessage) => void;
  onToggleExpanded?: (messageId: string, expanded: boolean) => void;
  expanded?: boolean;
}) {
  // Host-resolved skill metadata is authoritative; do not let the generic
  // activity heuristic replace a typed skill message.
  const activity = message.skill ? undefined : parseAsyncActivity(message.text);

  if (activity) return <ActivityDisclosure activity={activity} />;
  if (message.role === "notice") return <div className="notice-message">{message.text}</div>;

  if (message.role === "user") {
    return <UserMessage message={message} onCopy={onCopy} onFork={onFork} onToggleExpanded={onToggleExpanded} expanded={expanded} />;
  }

  const thinking = message.thinking?.trim() ? message.thinking : undefined;
  if (!message.text && !thinking) return null;

  return (
    <div className="message-shell assistant">
      <article className="message assistant">
        {thinking ? <ThinkingDisclosure thinking={thinking} streaming={streaming && !message.text} /> : null}
        {message.text ? (
          <div className="message-text">
            <Markdown streaming={streaming}>{message.text}</Markdown>
          </div>
        ) : null}
      </article>
      {onCopy ? <MessageActions
        onCopy={() => onCopy(message)}
        onFork={message.sourceEntryId && onFork ? () => onFork(message) : undefined}
      /> : null}
    </div>
  );
});
