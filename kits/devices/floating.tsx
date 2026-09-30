import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RegionProps } from "tau";
import type { Target } from "./protocol.js";
const VideoDeviceScreen = lazy(() => import("./video-screen.js"));
export type FloatingTarget = Target & { name: string };
export class FloatingDevice {
  private target?: FloatingTarget;
  private listeners = new Set<() => void>();
  get = () => this.target;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(target?: FloatingTarget): void { this.target = target; for (const listener of this.listeners) listener(); }
}
export function FloatingDeviceView({ store, invoke, actions }: RegionProps & { store: FloatingDevice; invoke: <T>(command: string, input?: unknown) => Promise<T> }) {
  const target = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [frame, setFrame] = useState<string>();
  const [video, setVideo] = useState(false), [fallback, setFallback] = useState(false);
  const receive = useCallback((canvas: HTMLCanvasElement | undefined) => setVideo(Boolean(canvas)), []);
  const fallbackVideo = useCallback(() => setFallback(true), []);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | undefined>(undefined);
  useEffect(() => {
    setFrame(undefined); setError(""); setFallback(false);
  }, [target]);
  useEffect(() => {
    if (!target) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const capture = async () => {
      if (document.hidden) { if (!cancelled) timer = setTimeout(() => { void capture(); }, 1000); return; }
      try { const next = await invoke<{ dataUrl: string }>("frame", target); if (!cancelled) { setFrame(next.dataUrl); setError(""); } }
      catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }
      if (!cancelled && !video) timer = setTimeout(() => { void capture(); }, 1000);
    };
    if (!video) void capture();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [target, invoke, video]);
  if (!target) return null;
  return <aside className="devices-floating" aria-label={`${target.name} floating screen`} style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
    <header onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => {
      const start = drag.current; if (!start) return;
      setOffset({ x: Math.max(-window.innerWidth + 260, Math.min(0, start.offsetX + event.clientX - start.x)), y: Math.max(-window.innerHeight + 400, Math.min(80, start.offsetY + event.clientY - start.y)) });
    }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
      <span>{target.name}</span><button aria-label="Close floating device" onPointerDown={(event) => event.stopPropagation()} onClick={() => store.set()}>×</button>
    </header>
    {!fallback && <div style={{ display: video ? "contents" : "none" }}><Suspense fallback={null}><VideoDeviceScreen target={target} invoke={invoke} name={target.name} onCanvas={receive} onFallback={fallbackVideo} /></Suspense></div>}
    {frame && !video && <img alt={`${target.name} floating screen`} src={frame} />}
    {error && <p role="alert">{error}</p>}
    <footer><button onClick={() => { actions.openPanel("devices"); store.set(); }}>Open controls</button><button onClick={() => { invoke("action", { ...target, action: "home" }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }}>Home</button></footer>
  </aside>;
}
