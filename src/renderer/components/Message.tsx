import { memo, useState } from "react";
import type { UiMessage } from "../../shared/contracts";
import { Markdown } from "./Markdown";

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const Message = memo(function Message({
  message,
  workedMs,
  streaming = false,
}: {
  message: UiMessage;
  workedMs?: number;
  streaming?: boolean;
}) {
  const [reasoningOpen, setReasoningOpen] = useState(false);

  if (message.role === "notice") return <div className="notice-message">{message.text}</div>;

  if (message.role === "user") {
    return (
      <article className="message user">
        <div className="message-text"><Markdown>{message.text}</Markdown></div>
        <time>{clockTime(message.timestamp)}</time>
      </article>
    );
  }

  return (
    <article className="message assistant">
      {message.thinking ? (
        <>
          <button className="reasoning-toggle" onClick={() => setReasoningOpen((open) => !open)}>
            {workedMs ? `Worked for ${duration(workedMs)}` : "Reasoning"}
            <i>{reasoningOpen ? "⌄" : "›"}</i>
          </button>
          {reasoningOpen ? <pre className="reasoning-body">{message.thinking}</pre> : null}
        </>
      ) : null}
      <div className="message-text">
        {message.text
          ? <Markdown streaming={streaming}>{message.text}</Markdown>
          : <span className="typing-mark">thinking</span>}
      </div>
    </article>
  );
});
