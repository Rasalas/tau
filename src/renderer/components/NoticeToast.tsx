import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { NoticeLevel } from "../../workbench/thread-view-store";
import { usePlatform } from "../platform-context";
import { noticeHeadline } from "./notice-text";

const LEVEL_LABELS: Record<NoticeLevel, string> = {
  info: "NOTICE",
  warning: "WARNING",
  error: "ERROR",
};

/**
 * One notice in the window's bottom-left corner: the level, the message, the
 * copy button and the dismissal. What it reads is the headline of the text it
 * was handed — a provider failure arrives as its raw payload — while the copy
 * button carries that text whole, since a notice is a thing to paste into a
 * bug report or a chat with someone who can act on it.
 */
export function NoticeToast({ level, message, onDismiss }: {
  level: NoticeLevel;
  message: string;
  onDismiss(): void;
}) {
  const platform = usePlatform();
  const [copied, setCopied] = useState(false);
  const headline = noticeHeadline(message);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    // A clipboard the client refuses is not worth a second notice: the button
    // simply stays as it was and the message is still there to select.
    void platform.clipboard.writeText(message).then(() => setCopied(true), () => undefined);
  };

  return <div className="toast notice-toast" data-level={level} role="status">
    <b>{LEVEL_LABELS[level]}</b>
    <span title={headline === message.trim() ? undefined : message}>{headline}</span>
    <button
      type="button"
      className={`toast-copy${copied ? " copied" : ""}`}
      title={copied ? "Copied" : "Copy notice"}
      aria-label={copied ? "Copied" : "Copy notice"}
      onClick={copy}
    >{copied ? <Check size={13} /> : <Copy size={13} />}</button>
    <button type="button" className="toast-dismiss" aria-label="Dismiss notice" onClick={onDismiss}>×</button>
  </div>;
}
