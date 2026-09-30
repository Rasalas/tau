import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Download, GitPullRequestArrow, Pause, Play, Trash2, X } from "lucide-react";
import { Dialog, tooltipProps } from "tau";
import { clock, EvidenceThumb, frameMark, frameTime, SaveVideoButton, sourceLabel, turnSummary } from "./card.js";
import type { EvidenceClient } from "./client.js";
import { exportName, saveFile } from "./export.js";
import type { EvidenceTurn } from "./protocol.js";

/** How long each picture stays while the viewer plays. */
export const PLAY_MS = 1_200;
/** Pictures listed on each side of the one on screen. */
const AROUND = 2;

export interface ViewerRequest {
  threadId: string;
  turn: EvidenceTurn;
  index: number;
  play?: boolean;
  /** The thread's title and the turn's number in it, for the head. */
  title?: string;
  turnNumber?: number;
}

/**
 * A turn's pictures one at a time over the whole window, dark in either theme:
 * beside the picture what happened around it, under it the timeline. Arrows,
 * Home and End step, Space plays. It saves the picture or the turn as a short
 * video, hands the turn's pictures to the review, or drops them.
 */
export function EvidenceViewer({ client, request, onClose, onDelete, onAttach, notify }: {
  client: EvidenceClient;
  request: ViewerRequest;
  onClose(): void;
  onDelete(): void;
  /** Absent when no review takes pictures. */
  onAttach?(): void;
  notify(message: string): void;
}) {
  const { threadId, turn } = request;
  const frames = turn.frames;
  const [index, setIndex] = useState(Math.min(request.index, frames.length - 1));
  const [playing, setPlaying] = useState(Boolean(request.play) && frames.length > 1);
  const [url, setUrl] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const frame = frames[index];

  useEffect(() => {
    if (!frame) return;
    let live = true;
    void client.image(threadId, frame.id).then((next) => { if (live) setUrl(next); });
    // The neighbours load behind it, so stepping does not wait.
    for (const near of [frames[index - 1], frames[index + 1]]) if (near) void client.image(threadId, near.id);
    return () => { live = false; };
  }, [client, frames, frame, index, threadId]);

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      if (index < frames.length - 1) setIndex(index + 1);
      else setPlaying(false);
    }, PLAY_MS);
    return () => clearTimeout(timer);
  }, [frames.length, index, playing]);

  useEffect(() => {
    strip.current?.querySelector(".evidence-thumb.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [index]);

  if (!frame) return null;
  const step = (to: number) => {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(frames.length - 1, to)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const to = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? frames.length - 1 : undefined;
    if (to !== undefined) {
      event.preventDefault();
      step(to);
    } else if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      setPlaying(!playing);
    }
  };
  const since = (at: number) => clock(at - turn.startedAt);
  const around = frames.slice(Math.max(0, index - AROUND), index + AROUND + 1);
  const heading = request.turnNumber ? `Evidence · turn ${String(request.turnNumber)}` : `Evidence · turn at ${frameTime(turn.startedAt)}`;

  return (
    <Dialog label="Evidence" className="evidence-viewer" onClose={onClose}>
      <div className="evidence-viewer-body" onKeyDown={onKeyDown}>
        <header className="evidence-viewer-head">
          <strong>{heading}</strong>
          <span className="evidence-viewer-meta">{[request.title, turnSummary(turn)].filter(Boolean).join(" · ")}</span>
          <button type="button" className="evidence-icon-button" aria-label="Save this picture" disabled={!url} onClick={() => { if (url) saveFile(url, exportName(frame.at, "jpg")); }} {...tooltipProps("Save this picture")}>
            <Download size={13} aria-hidden="true" />
          </button>
          <button type="button" className="evidence-icon-button danger" aria-label="Delete these pictures" onClick={onDelete} {...tooltipProps("Delete this turn's pictures")}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
          <SaveVideoButton client={client} threadId={threadId} turn={turn} notify={notify} />
          {onAttach ? (
            <button type="button" className="evidence-text-button evidence-attach" onClick={onAttach} {...tooltipProps("Add these pictures to the local pull request's description")}>
              <GitPullRequestArrow size={12} aria-hidden="true" />Attach to review
            </button>
          ) : null}
          <button type="button" className="evidence-icon-button evidence-close" aria-label="Close" onClick={onClose} {...tooltipProps("Close", { shortcut: "Esc" })}>
            <X size={13} aria-hidden="true" />
          </button>
        </header>
        <div className="evidence-viewer-main">
          <div className="evidence-viewer-stage">
            {url ? <img src={url} alt={frame.caption} width={frame.width} height={frame.height} /> : <span className="evidence-viewer-empty" />}
            <button type="button" className="evidence-nav" aria-label="Previous picture" disabled={index === 0} onClick={() => step(index - 1)}>
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <button type="button" className="evidence-nav next" aria-label="Next picture" disabled={index === frames.length - 1} onClick={() => step(index + 1)}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
          <aside className="evidence-viewer-side" aria-label="What happened around this picture">
            <div className="evidence-viewer-at" aria-live="polite">At {since(frame.at)}</div>
            <ol className="evidence-actions">
              {around.map((entry) => (
                <li key={entry.id} aria-current={entry === frame ? "true" : undefined}>
                  <button type="button" onClick={() => step(frames.indexOf(entry))}>
                    <span className="evidence-time">{since(entry.at)}</span>
                    <span>{entry.caption}</span>
                  </button>
                </li>
              ))}
            </ol>
            <p className="evidence-viewer-where">{[sourceLabel(frame), frame.url ?? frame.title].filter(Boolean).join(" · ")}</p>
            <p className="evidence-viewer-note">Pictures are taken at the start and end of a turn, after each preview or window action, and every ten seconds. Nothing is captured while a password or one-time-code field has focus.</p>
          </aside>
        </div>
        <footer className="evidence-viewer-foot">
          <button type="button" className="evidence-play" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying(!playing)} disabled={frames.length < 2} {...tooltipProps(playing ? "Pause" : "Play", { shortcut: "Space" })}>
            {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          </button>
          <div className="evidence-timeline" role="list" aria-label="Pictures" ref={strip}>
            {frames.map((entry, position) => (
              <div key={entry.id} className="evidence-tick" role="listitem">
                <EvidenceThumb item={false} client={client} threadId={threadId} frame={entry} index={position} total={frames.length} active={position === index} onOpen={() => step(position)} />
                <span className="evidence-time">{frameMark(entry, turn)}</span>
              </div>
            ))}
          </div>
          <span className="evidence-viewer-hint">← → step · space play</span>
        </footer>
      </div>
    </Dialog>
  );
}
