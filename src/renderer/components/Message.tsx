import { Bot, ChevronRight, Copy, GitFork, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { UiImagePreview, UiMessage, UiMessageImage } from "../../shared/contracts";
import { Markdown } from "./Markdown";

export const LONG_MESSAGE_LINE_LIMIT = 8;
export const LONG_MESSAGE_CHARACTER_LIMIT = 600;

export function isLongMessage(text: string): boolean {
  return text.split(/\r?\n/u).length > LONG_MESSAGE_LINE_LIMIT || text.length > LONG_MESSAGE_CHARACTER_LIMIT;
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
  const matches = text.matchAll(LOCAL_IMAGE_PATH);
  return [...new Set([...matches].map((match) => match[1].replaceAll("\\ ", " ")))].slice(0, 4);
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

  useEffect(() => {
    if (!preview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewIndex(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [preview]);

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
    {preview ? (
      <div
        className="attachment-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="Image preview"
        onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewIndex(undefined); }}
        onClick={(event) => { if (event.target === event.currentTarget) setPreviewIndex(undefined); }}
      >
        <figure onClick={(event) => event.stopPropagation()}>
          <button type="button" aria-label="Close preview" onClick={() => setPreviewIndex(undefined)}><X size={18} /></button>
          <img src={preview.src} alt={preview.alt} />
        </figure>
      </div>
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

interface ScrollPosition {
  container: HTMLElement;
  anchor?: HTMLElement;
  anchorTop?: number;
  tracked: HTMLElement;
  trackedHeight: number;
  trackedTop: number;
}

function findScrollContainer(element: HTMLElement): HTMLElement | undefined {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = window.getComputedStyle(parent).overflowY || window.getComputedStyle(parent).overflow;
    if (parent.classList.contains("transcript") || /auto|scroll|overlay/u.test(overflow)) return parent;
  }
  return undefined;
}

function captureScrollPosition(article: HTMLElement): ScrollPosition | undefined {
  const container = findScrollContainer(article);
  if (!container) return undefined;

  const containerTop = container.getBoundingClientRect().top;
  const tracked = article.closest<HTMLElement>(".virtual-transcript-row") ?? article;
  const trackedRect = tracked.getBoundingClientRect();
  const rows = [...container.querySelectorAll<HTMLElement>(".virtual-transcript-row")];
  const trackedIndex = rows.indexOf(tracked);
  const anchor = rows
    .slice(trackedIndex < 0 ? 0 : trackedIndex)
    .find((row) => row.getBoundingClientRect().top >= containerTop);
  const anchorRect = anchor?.getBoundingClientRect();
  return {
    container,
    anchor,
    anchorTop: anchorRect?.top,
    tracked,
    trackedHeight: trackedRect.height,
    trackedTop: trackedRect.top,
  };
}

function restoreScrollPosition(position: ScrollPosition): void {
  if (position.anchor && position.anchorTop !== undefined && position.anchor.isConnected) {
    position.container.scrollTop += position.anchor.getBoundingClientRect().top - position.anchorTop;
    return;
  }

  // A message at the transcript tail has no following row to anchor. If it is
  // above the viewport, compensate for its measured height change instead.
  if (position.trackedTop < position.container.getBoundingClientRect().top && position.tracked.isConnected) {
    const heightDelta = position.tracked.getBoundingClientRect().height - position.trackedHeight;
    position.container.scrollTop += heightDelta;
  }
}

function usePreservedScrollPosition(expanded: boolean, articleRef: RefObject<HTMLElement | null>, pendingPosition: MutableRefObject<ScrollPosition | undefined>) {
  useLayoutEffect(() => {
    const position = pendingPosition.current;
    if (!position) return;
    pendingPosition.current = undefined;

    // Virtualizer measurement is ResizeObserver-driven and may itself publish
    // on the next animation frame. Waiting a second frame observes the final
    // row position in both the browser and the absolute-row test fixture.
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => restoreScrollPosition(position));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [articleRef, expanded, pendingPosition]);
}

function UserMessage({
  message,
  onCopy,
  onFork,
}: {
  message: UiMessage;
  onCopy?: (message: UiMessage) => void;
  onFork?: (message: UiMessage) => void;
}) {
  const visibleText = withoutLocalImagePaths(message.text);
  const hasLocalImages = localImagePaths(message.text).length > 0;
  const persistedImages = message.images ?? [];
  const long = isLongMessage(visibleText);
  const [expanded, setExpanded] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const pendingPosition = useRef<ScrollPosition | undefined>(undefined);
  const contentId = `message-content-${message.id}`;
  usePreservedScrollPosition(expanded, articleRef, pendingPosition);

  const toggleExpanded = () => {
    if (articleRef.current) pendingPosition.current = captureScrollPosition(articleRef.current);
    setExpanded((value) => !value);
  };

  return (
    <div className="message-shell user">
      <article className="message user" ref={articleRef}>
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
}: {
  message: UiMessage;
  streaming?: boolean;
  onCopy?: (message: UiMessage) => void;
  onFork?: (message: UiMessage) => void;
}) {
  const activity = parseAsyncActivity(message.text);

  if (activity) return <ActivityDisclosure activity={activity} />;
  if (message.role === "notice") return <div className="notice-message">{message.text}</div>;

  if (message.role === "user") {
    return <UserMessage message={message} onCopy={onCopy} onFork={onFork} />;
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
