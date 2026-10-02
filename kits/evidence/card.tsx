import { useEffect, useState } from "react";
import { Image, Play, Video } from "lucide-react";
import { errorMessage, tooltipProps } from "tau";
import type { EvidenceClient } from "./client.js";
import { saveTurnVideo } from "./export.js";
import type { EvidenceFrame, EvidenceTurn } from "./protocol.js";

export function frameTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** `0:38`, a span of a turn. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

/** When in its turn a picture was taken: "start", "end", or the time since the turn began. */
export function frameMark(frame: Pick<EvidenceFrame, "at" | "trigger">, turn: Pick<EvidenceTurn, "startedAt">): string {
  return frame.trigger === "turn-start" ? "start" : frame.trigger === "turn-end" ? "end" : clock(frame.at - turn.startedAt);
}

/** Where a picture came from, in a word: the Preview, or the driven app's name. */
export function sourceLabel(frame: Pick<EvidenceFrame, "source" | "app">): string {
  return frame.source === "preview" ? "Preview" : frame.app ?? "Window";
}

export function countLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "picture" : "pictures"}`;
}

/** "12 pictures · 0:38"; a running turn has no length yet. */
export function turnSummary(turn: EvidenceTurn, short = false): string {
  const count = short ? String(turn.frames.length) : countLabel(turn.frames.length);
  // A picture of the turn's last moments may be stored a moment after the turn ended.
  return turn.endedAt === undefined ? count : `${count} · ${clock(Math.max(turn.endedAt, turn.frames.at(-1)?.at ?? 0) - turn.startedAt)}`;
}

/** One small picture, read from the host when it is first drawn. */
export function EvidenceThumb({ client, threadId, frame, index, total, mark, active = false, item = true, onOpen }: {
  client: EvidenceClient;
  threadId: string;
  frame: EvidenceFrame;
  index: number;
  total: number;
  /** A time drawn over the picture. */
  mark?: string;
  active?: boolean;
  /** A list item itself, or inside one. */
  item?: boolean;
  onOpen(): void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void client.image(threadId, frame.id, true).then((next) => { if (live) setUrl(next); });
    return () => { live = false; };
  }, [client, threadId, frame.id]);
  return (
    <button
      type="button"
      role={item ? "listitem" : undefined}
      className={`evidence-thumb${active ? " active" : ""}`}
      aria-label={`Picture ${String(index + 1)} of ${String(total)}: ${frame.caption}`}
      aria-current={active ? "true" : undefined}
      onClick={onOpen}
      {...tooltipProps(`${frame.caption}\n${sourceLabel(frame)} · ${frameTime(frame.at)}`, { variant: "lines" })}
    >
      {url ? <img src={url} alt="" draggable={false} /> : null}
      {mark ? <span className="evidence-mark">{mark}</span> : null}
    </button>
  );
}

/** Save video, with its progress in place of the label while it records. */
export function SaveVideoButton({ client, threadId, turn, notify }: {
  client: EvidenceClient;
  threadId: string;
  turn: EvidenceTurn;
  notify(message: string): void;
}) {
  const [progress, setProgress] = useState<string>();
  const save = async () => {
    try {
      await saveTurnVideo(turn, (id) => client.image(threadId, id), setProgress);
    } catch (error) {
      notify(`The video could not be made: ${errorMessage(error)}`);
    } finally {
      setProgress(undefined);
    }
  };
  return (
    <button type="button" className="evidence-text-button evidence-save-video" aria-label={progress ?? "Save video"} disabled={Boolean(progress) || turn.frames.length === 0} onClick={() => void save()}>
      <Video size={12} aria-hidden="true" /><span>{progress ?? "Save video"}</span>
    </button>
  );
}

/**
 * A turn's pictures under its answer: how many and how long, Play and Save
 * video, and the strip; a picture opens the viewer there.
 */
export function EvidenceCard({ client, threadId, turn, running, paused, onOpen, notify }: {
  client: EvidenceClient;
  threadId: string;
  turn: EvidenceTurn;
  running: boolean;
  paused?: string;
  onOpen(index: number, play?: boolean): void;
  notify(message: string): void;
}) {
  const frames = turn.frames;
  return (
    <section className="evidence-card" aria-label={`Pictures of this turn: ${countLabel(frames.length)}`} data-turn-id={turn.turnId}>
      <header className="evidence-card-head">
        <Image size={12} aria-hidden="true" />
        <span className="evidence-card-title">Evidence</span>
        <span className="evidence-card-meta">· {turnSummary(turn)}</span>
        <span className="evidence-card-meta compact">· {turnSummary(turn, true)}</span>
        {paused ? <span className="evidence-card-paused">Paused: {paused}</span> : null}
        <span className="evidence-card-actions">
          <button type="button" className="evidence-text-button evidence-play-text" aria-label="Play the pictures" onClick={() => onOpen(0, true)}>
            <Play size={11} aria-hidden="true" />Play
          </button>
          {running ? null : <SaveVideoButton client={client} threadId={threadId} turn={turn} notify={notify} />}
        </span>
      </header>
      <div className="evidence-strip" role="list" aria-label="Pictures">
        {frames.map((frame, index) => (
          <EvidenceThumb key={frame.id} client={client} threadId={threadId} frame={frame} index={index} total={frames.length} mark={frameMark(frame, turn)} onOpen={() => onOpen(index)} />
        ))}
      </div>
    </section>
  );
}
