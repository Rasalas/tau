import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Download, Film, Pause, Play, Trash2, X } from "lucide-react";
import { Dialog, errorMessage, tooltipProps } from "tau";
import { EvidenceThumb, frameTime, sourceLabel } from "./card.js";
import type { EvidenceClient } from "./client.js";
import { exportName, exportVideo, saveFile } from "./export.js";
import type { EvidenceTurn } from "./protocol.js";

/** How long each picture stays while the viewer plays. */
export const PLAY_MS = 1_200;

export interface ViewerRequest {
  threadId: string;
  turn: EvidenceTurn;
  index: number;
  play?: boolean;
}

/**
 * A turn's pictures one at a time, large (T3 Code's media dialog): arrows,
 * Home and End step, Space plays, the slider scrubs, the strip jumps. It can
 * save the picture on screen, the turn as a short video, or drop the turn's
 * pictures.
 */
export function EvidenceViewer({ client, request, onClose, onDelete, notify }: {
  client: EvidenceClient;
  request: ViewerRequest;
  onClose(): void;
  onDelete(): void;
  notify(message: string): void;
}) {
  const { threadId, turn } = request;
  const frames = turn.frames;
  const [index, setIndex] = useState(Math.min(request.index, frames.length - 1));
  const [playing, setPlaying] = useState(Boolean(request.play) && frames.length > 1);
  const [url, setUrl] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string>();
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
    if (event.target instanceof HTMLInputElement && event.target.type === "range") return;
    const to = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? frames.length - 1 : undefined;
    if (to !== undefined) {
      event.preventDefault();
      step(to);
    } else if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      setPlaying(!playing);
    }
  };
  const video = async () => {
    setExporting("Preparing…");
    try {
      const urls = await Promise.all(frames.map((entry) => client.image(threadId, entry.id)));
      const playable = frames.flatMap((entry, position) => urls[position] ? [{ url: urls[position], caption: entry.caption, at: entry.at }] : []);
      const blob = await exportVideo(playable, (done, total) => setExporting(`Recording ${String(done)}/${String(total)}…`));
      saveFile(blob, exportName(turn.startedAt, "webm"));
    } catch (error) {
      notify(`The video could not be made: ${errorMessage(error)}`);
    } finally {
      setExporting(undefined);
    }
  };
  const detail = [sourceLabel(frame), frameTime(frame.at), frame.url ?? frame.title].filter(Boolean).join(" · ");

  return (
    <Dialog label="Evidence" className="evidence-viewer" onClose={onClose}>
      <div className="evidence-viewer-body" onKeyDown={onKeyDown}>
        <header className="evidence-viewer-head">
          <div className="evidence-viewer-title">
            <strong>{frame.caption}</strong>
            <span>{detail}</span>
          </div>
          <span className="evidence-viewer-count" aria-live="polite">{index + 1} / {frames.length}</span>
          <button type="button" className="evidence-icon-button" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying(!playing)} disabled={frames.length < 2} {...tooltipProps(playing ? "Pause" : "Play", { shortcut: "Space" })}>
            {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          </button>
          <button type="button" className="evidence-icon-button" aria-label="Save this picture" disabled={!url} onClick={() => { if (url) saveFile(url, exportName(frame.at, "jpg")); }} {...tooltipProps("Save this picture")}>
            <Download size={14} aria-hidden="true" />
          </button>
          <button type="button" className="evidence-icon-button" aria-label="Save as video" disabled={Boolean(exporting)} onClick={() => void video()} {...tooltipProps(exporting ?? "Save the turn as a short video")}>
            <Film size={14} aria-hidden="true" />
          </button>
          <button type="button" className="evidence-icon-button danger" aria-label="Delete these pictures" onClick={onDelete} {...tooltipProps("Delete this turn's pictures")}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
          <button type="button" className="evidence-icon-button" aria-label="Close" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        {exporting ? <p className="evidence-viewer-note" role="status">{exporting}</p> : null}
        <div className="evidence-viewer-stage">
          <button type="button" className="evidence-nav" aria-label="Previous picture" disabled={index === 0} onClick={() => step(index - 1)}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          {url ? <img src={url} alt={frame.caption} width={frame.width} height={frame.height} /> : <span className="evidence-viewer-empty" style={{ aspectRatio: `${String(frame.width)} / ${String(frame.height)}` }} />}
          <button type="button" className="evidence-nav" aria-label="Next picture" disabled={index === frames.length - 1} onClick={() => step(index + 1)}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
        {frames.length > 1 ? (
          <input className="evidence-scrubber" type="range" min={0} max={frames.length - 1} value={index} aria-label="Scrub through the pictures" onChange={(event) => step(Number(event.target.value))} />
        ) : null}
        <div className="evidence-strip" role="list" aria-label="Pictures" ref={strip}>
          {frames.map((entry, position) => (
            <EvidenceThumb key={entry.id} client={client} threadId={threadId} frame={entry} index={position} total={frames.length} active={position === index} onOpen={() => step(position)} />
          ))}
        </div>
      </div>
    </Dialog>
  );
}
