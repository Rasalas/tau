import { CircleAlert, RotateCcw } from "lucide-react";
import type { UiMessage, UiPromptAttachment } from "../../shared/contracts";
import { noticeHeadline } from "./notice-text";

const IMAGES_ONLY = /^\[\d+ images? attached\]$/u;

/** Why a turn failed, where it failed; the whole provider text is one hover away. */
export function TurnErrorLine({ message, retries = 0, recovered = false, onRetry }: {
  message: string;
  /** Automatic retries after the first failure; the line counts them and shows the last reason. */
  retries?: number;
  recovered?: boolean;
  onRetry?: () => void;
}) {
  const headline = noticeHeadline(message);
  const count = retries > 0 ? `${recovered ? "Retried" : "Failed · retried"} ${retries}×` : undefined;
  return (
    <div className={`turn-error-line${recovered ? " recovered" : ""}`} role="status">
      <CircleAlert size={14} aria-hidden="true" />
      <span title={headline === message.trim() ? undefined : message}>
        {count ? <strong className="turn-error-count">{count}</strong> : null}
        {count ? " · " : null}
        {headline}
      </span>
      {onRetry ? (
        <button type="button" className="mini-button" onClick={onRetry}>
          <RotateCcw size={12} aria-hidden="true" />Retry
        </button>
      ) : null}
    </div>
  );
}

/** The prompt that led to a failed answer (the last one when none is named), to send once more. */
export function retryPrompt(messages: readonly UiMessage[], failed?: UiMessage): { text: string; attachments: UiPromptAttachment[] } | undefined {
  // By id: a collapsed retry row is a copy of the failed answer.
  const end = failed ? messages.findIndex((message) => message.id === failed.id) : messages.length;
  const prompt = [...messages.slice(0, end < 0 ? messages.length : end)].reverse().find((message) => message.role === "user");
  if (!prompt) return undefined;
  const images = prompt.images ?? [];
  // The host names an image-only prompt "[n images attached]"; that is not what was sent.
  const text = prompt.skill?.copyText ?? (images.length && IMAGES_ONLY.test(prompt.text) ? "" : prompt.text);
  const attachments = images.map((image, index): UiPromptAttachment => ({
    kind: "image",
    name: `image-${index + 1}`,
    mimeType: image.mimeType,
    data: image.data,
    size: Math.floor(image.data.length * 3 / 4),
  }));
  return text.trim() || attachments.length ? { text, attachments } : undefined;
}
