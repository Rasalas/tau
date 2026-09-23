import { useEffect, useState } from "react";
import { AppWindow, ArrowUpToLine, MonitorUp, Pause, Play } from "lucide-react";
import { Empty, errorMessage, tooltipProps } from "tau";
import { AgentCursorLayer, describeAction } from "./agent-cursor.js";
import type { ComputerUseScreenService, ScreenAccess, ScreenState } from "./screen-protocol.js";

interface Picture {
  url: string;
  width: number;
  height: number;
  live: boolean;
}

function useScreenState(service: ComputerUseScreenService, threadId: string | undefined): ScreenState | undefined {
  const [state, setState] = useState<ScreenState | undefined>(() => threadId ? service.state(threadId) : undefined);
  useEffect(() => {
    setState(threadId ? service.state(threadId) : undefined);
    if (!threadId) return undefined;
    let current = true;
    const stop = service.subscribe((next) => { if (next.threadId === threadId) setState(next); });
    // Events from before this window connected are only on the host.
    void service.load(threadId).then((loaded) => { if (current && loaded) setState(loaded); }).catch(() => undefined);
    return () => {
      current = false;
      stop();
    };
  }, [service, threadId]);
  return state;
}

const ACCESS_NOTE: Partial<Record<ScreenAccess, string>> = {
  "not-determined": "Live view needs Screen Recording for Tau. Until then this shows the agent's screenshots.",
  denied: "Screen Recording is off for Tau, so this shows the agent's screenshots.",
  restricted: "Screen Recording is restricted on this Mac, so this shows the agent's screenshots.",
};

/**
 * The window the agent of the thread on screen drives: its latest screenshot,
 * or a live picture of that window alone where the system allows it, with the
 * agent's inputs drawn over it.
 */
export default function ScreenView({ service, threadId }: { service: ComputerUseScreenService; threadId: string | undefined }) {
  const state = useScreenState(service, threadId);
  const [paused, setPaused] = useState(false);
  const [shot, setShot] = useState<Picture | undefined>();
  const [live, setLive] = useState<Picture | undefined>();
  const [access, setAccess] = useState<ScreenAccess | undefined>();
  const [icon, setIcon] = useState<string | null>(null);
  const [error, setError] = useState("");
  const target = state?.window;
  const windowKey = target ? `${target.pid}:${target.windowId ?? "?"}` : undefined;
  const seq = state?.frame?.seq;

  useEffect(() => {
    let current = true;
    void service.access().then((answer) => { if (current) setAccess(answer); }).catch(() => { if (current) setAccess("unavailable"); });
    return () => { current = false; };
  }, [service]);

  useEffect(() => {
    setShot(undefined);
    setLive(undefined);
    setIcon(null);
    if (!threadId || !windowKey) return undefined;
    let current = true;
    void service.icon(threadId).then((url) => { if (current) setIcon(url); }).catch(() => undefined);
    return () => { current = false; };
  }, [service, threadId, windowKey]);

  // A paused view keeps the picture it has; resuming fetches the newest.
  useEffect(() => {
    if (!threadId || seq === undefined || paused) return undefined;
    let current = true;
    void service.frame(threadId, seq).then((frame) => {
      if (current && frame) setShot({ url: `data:${frame.mimeType};base64,${frame.data}`, width: frame.width, height: frame.height, live: false });
    }).catch(() => undefined);
    return () => { current = false; };
  }, [paused, seq, service, threadId]);

  useEffect(() => {
    if (!threadId || !windowKey || target?.windowId === undefined || paused || access !== "granted") return undefined;
    setError("");
    return service.live(threadId, (frame) => setLive({ ...frame, live: true }), (reason) => {
      setLive(undefined);
      if (reason in ACCESS_NOTE || reason === "unavailable") setAccess(reason as ScreenAccess);
      else if (reason !== "ended") setError(reason);
    });
  }, [access, paused, service, threadId, target?.windowId, windowKey]);

  if (!threadId || !target) {
    return <section className="screen-view">
      <Empty icon={<MonitorUp size={18} />} title="No window yet" description="When the agent drives an app with computer use, its window shows here." />
    </section>;
  }

  const picture = live ?? shot;
  const latest = state.actions.at(-1);
  const appName = target.app ?? "App";
  const title = target.title ?? appName;
  const note = access ? ACCESS_NOTE[access] : undefined;
  const run = (work: () => Promise<unknown>) => { void work().then(() => setError("")).catch((problem: unknown) => setError(errorMessage(problem))); };

  return <section className="screen-view" aria-label="Screen">
    <div className="screen-header">
      <span className="screen-app" {...tooltipProps(appName)} aria-label={appName}>
        {icon ? <img src={icon} alt="" width={16} height={16} /> : <AppWindow size={14} />}
      </span>
      <span className="screen-title" {...tooltipProps(title, { when: "truncated" })}>{title}</span>
      <span className={picture?.live ? "screen-mode live" : "screen-mode"}>{paused ? "paused" : picture?.live ? "live" : "screenshot"}</span>
      <button
        className="icon-button compact"
        aria-label={paused ? "Follow the window" : "Pause"}
        aria-pressed={paused}
        {...tooltipProps(paused ? "Follow the window" : "Pause")}
        onClick={() => setPaused(!paused)}
      >{paused ? <Play size={13} /> : <Pause size={13} />}</button>
      <button
        className="icon-button compact"
        aria-label="Bring to front"
        disabled={!state.canBringToFront}
        {...tooltipProps(state.canBringToFront ? "Bring to front" : "The driver of this thread cannot raise the window")}
        onClick={() => run(() => service.bringToFront(threadId))}
      ><ArrowUpToLine size={13} /></button>
    </div>
    <div className="screen-stage">
      {picture ? <div className="screen-frame" style={{ aspectRatio: `${picture.width} / ${picture.height}`, width: `min(100cqw, calc(100cqh * ${picture.width / picture.height}))` }}>
        <img src={picture.url} alt={`${appName}: ${title}`} draggable={false} />
        <AgentCursorLayer actions={state.actions} space={state.frame ? { width: state.frame.width, height: state.frame.height } : undefined} />
      </div> : <p className="screen-waiting">Waiting for the agent's first screenshot of this window…</p>}
    </div>
    <div className={error ? "preview-status error" : "preview-status"}>
      {error || (latest ? describeAction(latest) : "")}
    </div>
    {note && !error ? <div className="screen-access">
      <span>{note}</span>
      <button className="text-button" onClick={() => run(() => service.openAccessSettings())}>Open Privacy settings</button>
    </div> : null}
  </section>;
}
