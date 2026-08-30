import { Bot, ChevronRight } from "lucide-react";
import { memo, useState } from "react";
import type { UiMessage } from "../../shared/contracts";
import { Markdown } from "./Markdown";

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

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
}: {
  message: UiMessage;
  streaming?: boolean;
}) {
  const activity = parseAsyncActivity(message.text);

  if (activity) return <ActivityDisclosure activity={activity} />;
  if (message.role === "notice") return <div className="notice-message">{message.text}</div>;

  if (message.role === "user") {
    return (
      <article className="message user">
        <div className="message-text"><Markdown>{message.text}</Markdown></div>
        <time>{clockTime(message.timestamp)}</time>
      </article>
    );
  }

  if (!message.text) return null;

  return (
    <article className="message assistant">
      <div className="message-text">
        <Markdown streaming={streaming}>{message.text}</Markdown>
      </div>
    </article>
  );
});
