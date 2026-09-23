import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { Dialog } from "tau";
import { evidenceKey, type EvidenceGroup, type LocalEvidence } from "./local-request.js";
import type { LocalRequestClient } from "./local-request-client.js";
import { relativeTime } from "./pull-request-logic.js";

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A picture as its thumbnail, or the picture itself where Evidence Kit is not there to shrink it. */
function usePicture(client: LocalRequestClient, frame: LocalEvidence, thumb: boolean): string | null | undefined {
  const [src, setSrc] = useState<string | null>();
  useEffect(() => {
    let current = true;
    setSrc(undefined);
    void client.image(frame, thumb).then((value) => { if (current) setSrc(value); });
    return () => { current = false; };
  }, [client, frame, thumb]);
  return src;
}

export function EvidenceThumb({ frame, client, selected, onToggle, onOpen }: {
  frame: LocalEvidence;
  client: LocalRequestClient;
  selected?: boolean;
  onToggle?(): void;
  onOpen?(): void;
}) {
  const src = usePicture(client, frame, true);
  const caption = frame.caption || "Picture";
  const picture = src ? <img src={src} alt={onOpen ? "" : caption} draggable={false} /> : src === null ? <ImageOff size={14} aria-label={onOpen ? undefined : `${caption} is gone`} /> : null;
  return (
    <div className={`lpr-thumb ${selected ? "selected" : ""}`} data-tooltip={`${caption} · ${clock(frame.at)}`}>
      {onOpen ? <button className="lpr-thumb-image" aria-label={`Open picture: ${caption}`} onClick={onOpen}>{picture}</button> : <span className="lpr-thumb-image">{picture}</span>}
      {onToggle ? (
        <input className="lpr-thumb-pick" type="checkbox" checked={Boolean(selected)} aria-label={`Use in the description: ${caption}`} onChange={onToggle} />
      ) : null}
    </div>
  );
}

/** The branch's pictures by the commit that took in each turn's work, newest first. */
export function EvidenceGroups({ groups, titles, client, selected, onToggle, onOpen, compact = false }: {
  groups: readonly EvidenceGroup[];
  titles: ReadonlyMap<string, string>;
  client: LocalRequestClient;
  selected: ReadonlySet<string>;
  onToggle(frame: LocalEvidence): void;
  onOpen(frames: readonly LocalEvidence[], index: number): void;
  /** Leaves the commit headings out, for a commit's own row. */
  compact?: boolean;
}) {
  return (
    <>
      {groups.map((group) => {
        const frames = group.turns.flatMap((turn) => turn.frames);
        return (
          <section key={group.commit?.sha ?? "uncommitted"} className="lpr-group" aria-label={group.commit ? `Pictures of ${group.commit.subject}` : "Pictures of work not committed yet"}>
            {compact ? null : (
              <header className="lpr-group-head">
                {group.commit ? <>
                  <strong title={group.commit.subject}>{group.commit.subject}</strong>
                  <code>{group.commit.sha.slice(0, 7)}</code>
                  <span>{relativeTime(new Date(group.commit.at).toISOString())}</span>
                </> : <strong>Not committed yet</strong>}
                <span className="spacer" />
                <span>{frames.length} {frames.length === 1 ? "picture" : "pictures"}</span>
              </header>
            )}
            {group.turns.map((turn) => (
              <div key={`${turn.threadId}\n${turn.turnId}`} className="lpr-turn">
                <small className="lpr-turn-label">{titles.get(turn.threadId) ?? "A thread"} · turn at {clock(turn.startedAt)}</small>
                <div className="lpr-strip">
                  {turn.frames.map((frame) => (
                    <EvidenceThumb key={evidenceKey(frame)} frame={frame} client={client} selected={selected.has(evidenceKey(frame))}
                      onToggle={() => onToggle(frame)} onOpen={() => onOpen(frames, frames.indexOf(frame))} />
                  ))}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}

/** One picture at full size; arrows step through its group. */
export function EvidenceViewer({ frames, index, client, selected, onToggle, onClose }: {
  frames: readonly LocalEvidence[];
  index: number;
  client: LocalRequestClient;
  selected: ReadonlySet<string>;
  onToggle(frame: LocalEvidence): void;
  onClose(): void;
}) {
  const [at, setAt] = useState(index);
  const frame = frames[Math.min(at, frames.length - 1)]!;
  const src = usePicture(client, frame, false);
  const step = (offset: number) => setAt((current) => (current + offset + frames.length) % frames.length);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
      if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <Dialog label="Picture" className="lpr-viewer" onClose={onClose}>
      <div className="lpr-viewer-stage">
        {src ? <img src={src} alt={frame.caption} /> : <span className="lpr-viewer-empty">{src === null ? "This picture is gone." : "Loading…"}</span>}
      </div>
      <footer className="lpr-viewer-bar">
        <button className="icon-button compact" aria-label="Previous picture" disabled={frames.length < 2} onClick={() => step(-1)}><ChevronLeft size={14} /></button>
        <span className="lpr-viewer-count">{at + 1} / {frames.length}</span>
        <button className="icon-button compact" aria-label="Next picture" disabled={frames.length < 2} onClick={() => step(1)}><ChevronRight size={14} /></button>
        <span className="lpr-viewer-caption" title={frame.caption}>{frame.caption || "Picture"} · {clock(frame.at)}</span>
        <span className="spacer" />
        <label className="lpr-viewer-pick">
          <input type="checkbox" checked={selected.has(evidenceKey(frame))} onChange={() => onToggle(frame)} /> Use in the description
        </label>
        <button className="mini-button" onClick={onClose}>Close</button>
      </footer>
    </Dialog>
  );
}
