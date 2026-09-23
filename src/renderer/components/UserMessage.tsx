import { FileText, Sparkles } from "lucide-react";
import { useContext, useState, type ReactNode } from "react";
import type { UiMessage } from "../../shared/contracts";
import { WorkbenchShellContext } from "../workbench-context";
import { LazyFeatureBoundary } from "./LazyFeature";
import { drawsBlocksFor, splitMessageBlocks } from "./message-blocks";
import { Markdown } from "./Markdown";
import { MessageActions } from "./MessageActions";
import { MessageImages, PersistedMessageImages } from "./MessageImages";
import { copyableMessage, embeddedFileContexts, localImagePaths, visibleUserMessageText } from "./MessageText";
import { isLongMessage } from "./message-grapheme";
import { compactTimestamp, fullTimestamp } from "./message-timestamp";

interface UserMessageProps {
  message: UiMessage;
  onCopy?: (message: UiMessage) => void;
  onFork?: (message: UiMessage) => void;
  onEdit?: (message: UiMessage) => void;
  onToggleExpanded?: (messageId: string, expanded: boolean) => void;
  expanded?: boolean;
}

function SkillChip({ name }: { name: string }) {
  return <span
    className="skill-chip"
    role="img"
    aria-label={`Skill ${name}`}
    title={`Skill: ${name}`}
    data-skill-name={name}
  >
    <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
    <strong>{name}</strong>
    <span>Skill</span>
  </span>;
}

/** Tagged blocks an extension draws for user messages, split from the text the bubble shows. */
function useUserBlocks(message: UiMessage): { text: string; blocks: ReactNode[] } {
  const registry = useContext(WorkbenchShellContext)?.registry;
  if (!registry || !message.text.includes("<")) return { text: message.text, blocks: [] };
  const contributions = registry.getMessageBlocks().filter((block) => drawsBlocksFor(block, "user"));
  if (contributions.length === 0) return { text: message.text, blocks: [] };
  const parts = splitMessageBlocks(message.text, contributions.map((block) => block.tag));
  if (parts.every((part) => part.kind === "text")) return { text: message.text, blocks: [] };
  return {
    text: parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n\n"),
    blocks: parts.flatMap((part, index) => {
      if (part.kind === "text") return [];
      const block = contributions.find((entry) => entry.tag === part.tag)!;
      return [<LazyFeatureBoundary key={index} label={block.id} extensionId={block.extensionId} extensionName={block.extensionName} registry={registry}>
        <block.Component body={part.body} complete={part.complete} message={message} streaming={false} />
      </LazyFeatureBoundary>];
    }),
  };
}

export function UserMessage({
  message,
  onCopy,
  onFork,
  onEdit,
  onToggleExpanded,
  expanded: controlledExpanded,
}: UserMessageProps) {
  const { text, blocks } = useUserBlocks(message);
  const visibleText = visibleUserMessageText(text);
  const attachedFiles = embeddedFileContexts(text);
  const hasLocalImages = localImagePaths(message.text).length > 0;
  const persistedImages = message.images ?? [];
  const hasMessageContent = Boolean(visibleText || message.skill || attachedFiles.length > 0);
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
      {blocks.length > 0 ? <div className="message-user-blocks">{blocks}</div> : null}
      <PersistedMessageImages images={persistedImages} />
      {hasLocalImages ? <MessageImages text={message.text} /> : null}
      <article className="message user">
        {hasMessageContent ? (
          <div className="message-text">
            <div
              id={contentId}
              className={`message-text-content${long && !expanded ? " collapsed" : ""}`}
              data-collapsed={long && !expanded ? "true" : "false"}
            >
              {message.skill ? <SkillChip name={message.skill.name} /> : null}
              {attachedFiles.map((file) => (
                <span className="file-context-chip" key={file} title={`Included file context: ${file}`}>
                  <FileText size={11} strokeWidth={2} />
                  <span>{file}</span>
                </span>
              ))}
              {visibleText
                ? long && !expanded
                  ? <span style={{ whiteSpace: "pre-wrap" }}>{visibleText}</span>
                  : <Markdown inlineStart={Boolean(message.skill || attachedFiles.length > 0)}>{visibleText}</Markdown>
                : null}
            </div>
          </div>
        ) : null}
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
            message={message}
            onCopy={() => onCopy(copyableMessage(message))}
            onFork={message.sourceEntryId && onFork ? () => onFork(message) : undefined}
            onEdit={message.sourceEntryId && onEdit ? () => onEdit(message) : undefined}
          /> : null}
        </div>
      </article>
    </div>
  );
}
