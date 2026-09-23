import { useEffect, useState } from "react";
import { Images, Play } from "lucide-react";
import { tooltipProps } from "tau";
import type { EvidenceClient } from "./client.js";
import type { EvidenceFrame, EvidenceTurn } from "./protocol.js";

export function frameTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Where a picture came from, in a word: the Preview, or the driven app's name. */
export function sourceLabel(frame: Pick<EvidenceFrame, "source" | "app">): string {
  return frame.source === "preview" ? "Preview" : frame.app ?? "Window";
}

export function countLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "image" : "images"}`;
}

/** One small picture, read from the host when it is first drawn. */
export function EvidenceThumb({ client, threadId, frame, index, total, active = false, onOpen }: {
  client: EvidenceClient;
  threadId: string;
  frame: EvidenceFrame;
  index: number;
  total: number;
  active?: boolean;
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
      role="listitem"
      className={`evidence-thumb${active ? " active" : ""}`}
      aria-label={`Picture ${String(index + 1)} of ${String(total)}: ${frame.caption}`}
      aria-current={active ? "true" : undefined}
      onClick={onOpen}
      {...tooltipProps(`${frame.caption}\n${sourceLabel(frame)} · ${frameTime(frame.at)}`, { variant: "lines" })}
    >
      {url ? <img src={url} alt="" draggable={false} /> : <span className="evidence-thumb-empty" aria-hidden="true" />}
    </button>
  );
}

/**
 * A turn's pictures under its answer: how many, from where, and the strip
 * to scrub through; a picture opens the viewer there.
 */
export function EvidenceCard({ client, threadId, turn, running, paused, onOpen }: {
  client: EvidenceClient;
  threadId: string;
  turn: EvidenceTurn;
  running: boolean;
  paused?: string;
  onOpen(index: number, play?: boolean): void;
}) {
  const frames = turn.frames;
  const sources = [...new Set(frames.map(sourceLabel))];
  return (
    <section className="evidence-card" aria-label={`Pictures of this turn: ${countLabel(frames.length)}`} data-turn-id={turn.turnId}>
      <header className="evidence-card-head">
        <Images size={14} aria-hidden="true" />
        <strong>{running ? "Capturing" : "Evidence"}</strong>
        <span className="evidence-card-meta">· {countLabel(frames.length)} · {sources.join(", ")}</span>
        {paused ? <span className="evidence-card-paused">Paused: {paused}</span> : null}
        <span className="evidence-spacer" />
        <button type="button" className="evidence-icon-button" aria-label="Play the pictures" onClick={() => onOpen(0, true)} {...tooltipProps("Play")}>
          <Play size={13} aria-hidden="true" />
        </button>
      </header>
      <div className="evidence-strip" role="list" aria-label="Pictures">
        {frames.map((frame, index) => (
          <EvidenceThumb key={frame.id} client={client} threadId={threadId} frame={frame} index={index} total={frames.length} onOpen={() => onOpen(index)} />
        ))}
      </div>
    </section>
  );
}
