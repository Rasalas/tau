import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Globe, MonitorOff } from "lucide-react";
import { tooltipProps, type RegionProps } from "tau";
import { PREVIEW_HOST_EXTENSION_ID, type PreviewState } from "./protocol.js";
import { environmentsCell } from "./machine.js";
import { isPreviewState, readPreviewState } from "./store.js";
import { useLiveFrames, type LiveFrameAnswer, type LiveFrameSource } from "./live-frames.js";

/** How often a look-in asks the other machine what its Preview shows. */
export const LOOK_IN_STATE_MS = 4_000;

/**
 * Another machine's Preview in a tab that looks in on one of its threads:
 * small, and view only. Its page and frames come over the window's own
 * connection there, through commands that only read; clicking or typing
 * happens after "Open on <machine>".
 */
export default function LookInPreview({ lookIn }: RegionProps) {
  const environments = environmentsCell.use();
  const read = environments?.readExtension;
  const machine = lookIn?.machine;
  const connected = lookIn?.connected === true;
  const [state, setState] = useState<PreviewState>();
  const [collapsed, setCollapsed] = useState(false);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!read || !machine || !connected) {
      setState(undefined);
      return undefined;
    }
    let stopped = false;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      void read(machine, PREVIEW_HOST_EXTENSION_ID, "state").then(
        (value) => { if (!stopped) setState(isPreviewState(value) ? readPreviewState(value) : undefined); },
        () => { if (!stopped) setState(undefined); },
      );
    };
    load();
    const timer = setInterval(load, LOOK_IN_STATE_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [connected, machine, read]);

  const shows = Boolean(state?.url) && !state?.noWindow && !collapsed;
  const source = useMemo<LiveFrameSource | undefined>(() => read && machine && shows
    ? async (maxWidth, since) => await read(machine, PREVIEW_HOST_EXTENSION_ID, "live-frame", { maxWidth, ...(since ? { since } : {}) }) as LiveFrameAnswer
    : undefined, [machine, read, shows]);
  const frames = useLiveFrames(source, stage, { active: shows });

  if (!lookIn || !state?.url) return null;
  const name = lookIn.machineName;
  const page = state.title || state.url;
  const driving = state.driver?.source === "browser" && state.driver.threadId === lookIn.sessionId;
  return <section className="preview-look-in" aria-label={`Preview on ${name}`}>
    <header className="preview-look-in-bar">
      <button
        type="button"
        className="preview-look-in-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Show ${name}'s Preview` : `Hide ${name}'s Preview`}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
        <Globe size={13} aria-hidden="true" />
        <span className="preview-look-in-title" title={state.url}>{page}</span>
      </button>
      {driving ? <span className="preview-look-in-driver" {...tooltipProps("This thread's agent uses the page")}><Bot size={11} aria-hidden="true" />Agent</span> : null}
      <small {...tooltipProps(`Open on ${name} to click or type in it`)}>View only</small>
    </header>
    {collapsed ? null : <div ref={stage} className="preview-look-in-stage">
      {state.noWindow
        ? <span className="preview-look-in-note"><MonitorOff size={13} aria-hidden="true" />{name} has no display</span>
        : frames.picture
          ? <img src={frames.picture.url} width={frames.picture.width} height={frames.picture.height} alt={`${name}'s Preview: ${page}`} draggable={false} />
          : <span className="preview-look-in-note">Waiting for a picture…</span>}
    </div>}
  </section>;
}
