import { Bot, ChevronRight, Copy, GitFork } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { UiImagePreview, UiMessage } from "../../shared/contracts";
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
  return <div className="message-images">
    {previews.map((image) => <img key={image.name} src={image.dataUrl} alt={image.name} />)}
  </div>;
}

function MessageActions({ onCopy, onFork }: { onCopy(): void; onFork?: () => void }) {
  return <div className="message-actions">
    <button type="button" onClick={onCopy} title="Copy message"><Copy size={13} /><span>Copy</span></button>
    {onFork ? <button type="button" onClick={onFork} title="Fork through this message"><GitFork size={13} /><span>Fork</span></button> : null}
  </div>;
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
    const visibleText = withoutLocalImagePaths(message.text);
    const hasLocalImages = localImagePaths(message.text).length > 0;
    return (
      <div className="message-shell user">
        <article className="message user">
          <div className="message-text">
            {visibleText ? <Markdown>{visibleText}</Markdown> : hasLocalImages ? <span className="image-placeholder">Image attached</span> : null}
            {hasLocalImages ? <MessageImages text={message.text} /> : null}
          </div>
          <div className="message-user-meta">
            <time>{clockTime(message.timestamp)}</time>
            {onCopy ? <MessageActions
              onCopy={() => onCopy(message)}
              onFork={message.sourceEntryId && onFork ? () => onFork(message) : undefined}
            /> : null}
          </div>
        </article>
      </div>
    );
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
