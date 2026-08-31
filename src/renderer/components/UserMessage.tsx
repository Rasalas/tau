import { useState } from "react";
import type { UiMessage } from "../../shared/contracts";
import { Markdown } from "./Markdown";
import { MessageActions } from "./MessageActions";
import { MessageImages, PersistedMessageImages } from "./MessageImages";
import { copyableMessage, localImagePaths, visibleUserMessageText } from "./MessageText";
import { isLongMessage } from "./message-grapheme";
import { compactTimestamp, fullTimestamp } from "./message-timestamp";

interface UserMessageProps {
  message: UiMessage;
  onCopy?: (message: UiMessage) => void;
  onFork?: (message: UiMessage) => void;
  onToggleExpanded?: (messageId: string, expanded: boolean) => void;
  expanded?: boolean;
}

export function UserMessage({
  message,
  onCopy,
  onFork,
  onToggleExpanded,
  expanded: controlledExpanded,
}: UserMessageProps) {
  const visibleText = visibleUserMessageText(message.text);
  const hasLocalImages = localImagePaths(message.text).length > 0;
  const persistedImages = message.images ?? [];
  const long = isLongMessage(visibleText);
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const contentId = `message-content-${message.id}`;

  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    onToggleExpanded?.(message.id, nextExpanded);
    if (controlledExpanded === undefined) setLocalExpanded(nextExpanded);
  };

  return (
    <div className="message-shell user">
      <article className="message user">
        <div className="message-text">
          <div
            id={contentId}
            className={`message-text-content${long && !expanded ? " collapsed" : ""}`}
            data-collapsed={long && !expanded ? "true" : "false"}
          >
            {visibleText
              ? long && !expanded
                ? <span style={{ whiteSpace: "pre-wrap" }}>{visibleText}</span>
                : <Markdown>{visibleText}</Markdown>
              : hasLocalImages && persistedImages.length === 0 ? <span className="image-placeholder">Image attached</span> : null}
          </div>
          <PersistedMessageImages images={persistedImages} />
          {hasLocalImages ? <MessageImages text={message.text} /> : null}
        </div>
        {long ? (
          <button
            className="message-expand"
            type="button"
            aria-controls={contentId}
            aria-expanded={expanded}
            onClick={toggleExpanded}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
        <div className="message-user-meta">
          <time
            dateTime={new Date(message.timestamp).toISOString()}
            title={fullTimestamp(message.timestamp)}
            aria-label={`Sent ${fullTimestamp(message.timestamp)}`}
          >
            {compactTimestamp(message.timestamp)}
          </time>
          {onCopy ? <MessageActions
            onCopy={() => onCopy(copyableMessage(message))}
            onFork={message.sourceEntryId && onFork ? () => onFork(message) : undefined}
          /> : null}
        </div>
      </article>
    </div>
  );
}
