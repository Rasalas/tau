import { Bot, ChevronRight, Copy, GitFork, X } from "lucide-react";
import { createPortal } from "react-dom";
import { memo, useEffect, useRef, useState } from "react";
import type { UiImagePreview, UiMessage, UiMessageImage } from "../../shared/contracts";
import { Markdown } from "./Markdown";

export const LONG_MESSAGE_LINE_LIMIT = 8;
export const LONG_MESSAGE_GRAPHEME_LIMIT = 600;

const MARK = /\p{Mark}/u;

function fallbackGraphemeCount(text: string, limit: number): number {
  let count = 0;
  let joined = false;
  let regionalIndicators = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (character === "\u200d") {
      joined = true;
      continue;
    }
    if (MARK.test(character) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)) continue;
    if (joined) {
      joined = false;
      continue;
    }
    if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) {
      regionalIndicators += 1;
      if (regionalIndicators % 2 === 1) count += 1;
    } else {
      regionalIndicators = 0;
      count += 1;
    }
    if (count > limit) return count;
  }
  return count;
}

function visibleCharacterCount(text: string, limit: number): number {
  const Segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? (Intl as typeof Intl & {
      Segmenter: new (locales?: string | string[], options?: { granularity: "grapheme" }) => { segment(value: string): Iterable<unknown> };
    }).Segmenter
    : undefined;
  if (Segmenter) {
    let count = 0;
    for (const _segment of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      count += 1;
      if (count > limit) return count;
    }
    return count;
  }

  return fallbackGraphemeCount(text, limit);
}

export function isLongMessage(text: string): boolean {
  let lines = 1;
  for (const character of text) {
    if (character === "\n") {
      lines += 1;
      if (lines > LONG_MESSAGE_LINE_LIMIT) return true;
    }
  }
  return visibleCharacterCount(text, LONG_MESSAGE_GRAPHEME_LIMIT) > LONG_MESSAGE_GRAPHEME_LIMIT;
}

export function compactTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fullTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], { dateStyle: "full", timeStyle: "long" });
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

const LOCAL_IMAGE_PATH = /(\/(?:(?:\\ )|[^\s'"<>])+?\.(?:png|jpe?g|gif|webp))(?=\s|$|[),;])/giu;

export function localImagePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(LOCAL_IMAGE_PATH)) {
    const path = match[1].replaceAll("\\ ", " ");
    if (!paths.includes(path)) paths.push(path);
    if (paths.length === 4) break;
  }
  return paths;
}

export function withoutLocalImagePaths(text: string): string {
  return text.replace(LOCAL_IMAGE_PATH, "").replace(/^[ \t]+|[ \t]+$/gmu, "").trim();
}

const imagePreviewCache = new Map<string, Promise<UiImagePreview | undefined>>();

function cachedImagePreview(path: string): Promise<UiImagePreview | undefined> {
  const cached = imagePreviewCache.get(path);
  if (cached) return cached;
  if (imagePreviewCache.size >= 8) imagePreviewCache.delete(imagePreviewCache.keys().next().value as string);
  const request = window.tau!.readImagePreview(path).catch((error) => {
    imagePreviewCache.delete(path);
    throw error;
  });
  imagePreviewCache.set(path, request);
  return request;
}

interface MessageImage {
  key: string;
  src: string;
  alt: string;
}

function MessageImageGallery({ images }: { images: readonly MessageImage[] }) {
  const [previewIndex, setPreviewIndex] = useState<number>();
  const preview = previewIndex === undefined ? undefined : images[previewIndex];
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!preview) return;
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewIndex(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      previouslyFocused.current?.focus();
      previouslyFocused.current = null;
    };
  }, [previewIndex]);

  if (images.length === 0) return null;
  return <>
    <div className="message-images">
      {images.map((image, index) => (
        <button
          className="message-image-button"
          key={image.key}
          type="button"
          aria-label={`Open image ${index + 1}`}
          onClick={() => setPreviewIndex(index)}
        >
          <img src={image.src} alt={image.alt} />
        </button>
      ))}
    </div>
    {preview ? createPortal(
      <div
        className="attachment-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="Image preview"
        onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewIndex(undefined); }}
        onClick={(event) => { if (event.target === event.currentTarget) setPreviewIndex(undefined); }}
      >
        <figure onClick={(event) => event.stopPropagation()}>
          <button ref={closeButtonRef} type="button" aria-label="Close preview" onClick={() => setPreviewIndex(undefined)}><X size={18} /></button>
          <img src={preview.src} alt={preview.alt} />
        </figure>
      </div>,
      document.body,
    ) : null}
  </>;
}

function PersistedMessageImages({ images }: { images: readonly UiMessageImage[] }) {
  return <MessageImageGallery images={images.map((image, index) => ({
    key: `${index}-${image.mimeType}-${image.data.slice(0, 16)}`,
    src: `data:${image.mimeType};base64,${image.data}`,
    alt: "Attached image",
  }))} />;
}

function MessageImages({ text }: { text: string }) {
  const [previews, setPreviews] = useState<UiImagePreview[]>([]);
  useEffect(() => {
    const paths = localImagePaths(text);
    if (paths.length === 0 || !window.tau) {
      setPreviews([]);
      return;
    }
    let active = true;
    void Promise.all(paths.map(cachedImagePreview))
      .then((images) => { if (active) setPreviews(images.filter((image): image is UiImagePreview => Boolean(image))); })
      .catch(() => { if (active) setPreviews([]); });
    return () => { active = false; };
  }, [text]);
  if (previews.length === 0) return null;
  return <MessageImageGallery images={previews.map((image) => ({ key: image.name, src: image.dataUrl, alt: image.name }))} />;
}

function MessageActions({ onCopy, onFork }: { onCopy(): void; onFork?: () => void }) {
  return <div className="message-actions">
    <button type="button" onClick={onCopy} title="Copy message"><Copy size={13} /><span>Copy</span></button>
    {onFork ? <button type="button" onClick={onFork} title="Fork through this message"><GitFork size={13} /><span>Fork</span></button> : null}
  </div>;
}

function UserMessage({
  message,
  onCopy,
  onFork,
  onToggleExpanded,
  expanded: controlledExpanded,
}: {
  message: UiMessage;
  onCopy?: (message: UiMessage) => void;
  onFork?: (message: UiMessage) => void;
  onToggleExpanded?: (messageId: string, expanded: boolean) => void;
  expanded?: boolean;
}) {
  const visibleText = withoutLocalImagePaths(message.text);
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
            {visibleText ? <Markdown>{visibleText}</Markdown> : hasLocalImages && persistedImages.length === 0 ? <span className="image-placeholder">Image attached</span> : null}
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
            onCopy={() => onCopy(message)}
            onFork={message.sourceEntryId && onFork ? () => onFork(message) : undefined}
          /> : null}
        </div>
      </article>
    </div>
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
  const activity = parseAsyncActivity(message.text);

  if (activity) return <ActivityDisclosure activity={activity} />;
  if (message.role === "notice") return <div className="notice-message">{message.text}</div>;

  if (message.role === "user") {
    return <UserMessage message={message} onCopy={onCopy} onFork={onFork} onToggleExpanded={onToggleExpanded} expanded={expanded} />;
  }

  if (!message.text) return null;

  return (
    <div className="message-shell assistant">
      <article className="message assistant">
        <div className="message-text">
          <Markdown streaming={streaming}>{message.text}</Markdown>
        </div>
      </article>
      {onCopy ? <MessageActions
        onCopy={() => onCopy(message)}
        onFork={message.sourceEntryId && onFork ? () => onFork(message) : undefined}
      /> : null}
    </div>
  );
});
