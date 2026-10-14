import { Minimize2 } from "lucide-react";
import { useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import {
  FRAME_DEFAULT_HEIGHT,
  FRAME_KEYS_MESSAGE,
  FRAME_SCHEME_MESSAGE,
  clampFrameHeight,
  frameAllowAttribute,
  readFrameKeyDown,
  type SandboxFramePermissions,
} from "../../shared/sandbox-frame";
import { useColorScheme } from "../use-color-scheme";
import { WorkbenchContext } from "../workbench-context";
import { frameChords, replayableKey } from "./sandbox-frame-keys";
import { tooltipProps } from "./ui/Tooltip";

export interface SandboxFrameHandle {
  /** Posts to the framed document with target "*" (its origin is opaque). No-op before it loaded or spoke, after it stopped, or after unmount. */
  post(message: unknown): void;
  /** True only while this frame has focus and the user's activation is live (navigator.userActivation.isActive): the one moment a link may open. */
  hasUserActivation(): boolean;
  /** Current width of the frame's box in CSS px (0 before layout). */
  width(): number;
  /** Current size of the frame element itself in CSS px, e.g. for full-screen container dimensions. */
  size(): { width: number; height: number };
}

export interface SandboxFrameProps {
  /** Resource URL; the frame keeps the first non-empty value for its whole life (a changed src would reload the app). Undefined renders nothing yet. */
  src: string | undefined;
  title: string;
  permissions?: SandboxFramePermissions | undefined;
  /** The height the document asked for; clamped to 80..2000 here, default 320, ignored in full screen. */
  height?: number | undefined;
  /** Lowers the 80 px floor for a frame inside a row (API 1.62.0). */
  minHeight?: number | undefined;
  bordered?: boolean | undefined;
  fullscreen?: boolean | undefined;
  /** Called when the frame wants to leave full screen: Escape pressed outside the document, focus moving outside the box, or the exit button. Controlled: the caller sets `fullscreen`. */
  onFullscreenChange?(fullscreen: boolean): void;
  /** Only messages whose event.source is this frame's own window arrive here. */
  onMessage(data: unknown): void;
  /** The document navigated away from the page that was served (a second load). The frame is replaced by a notice and nothing more is delivered. */
  onStopped?(): void;
  /** Notice text after a stop; default "This page left its document and was stopped". */
  stoppedLabel?: string | undefined;
  onWidth?(width: number): void;
  /** Shown in the full-screen header, with an exit button (aria-label "Exit full screen"). */
  label?: string | undefined;
  handleRef?: Ref<SandboxFrameHandle> | undefined;
}

// Full screen is the top layer; without the Popover API the frame stays inline.
const popoverSupported = () => typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

/**
 * A document served by the host, drawn in an opaque-origin frame (ADR 0032).
 * Isolation lives here: the sandbox and `allow` attributes, the message source
 * check, the navigation lock and full screen without a reload. A click gives the
 * keyboard to the document, so it passes on the app shortcuts that only change
 * the view; the frame checks each one before it replays it.
 */
export function SandboxFrame(props: SandboxFrameProps) {
  const { title, permissions, bordered, handleRef } = props;
  const wantsWidth = Boolean(props.onWidth);
  const scheme = useColorScheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [kept, setKept] = useState(props.src || undefined);
  if (!kept && props.src) setKept(props.src);
  const [loaded, setLoaded] = useState(false);
  const [stopped, setStopped] = useState(false);
  const loads = useRef(0);
  // The document may speak before its load event; the reply must not be dropped.
  const alive = useRef(false);
  const latest = useRef(props);
  const registry = useContext(WorkbenchContext)?.registry;
  const registryRef = useRef(registry);
  // Layout effects: the listener must exist when the frame commits, before its document can speak.
  useLayoutEffect(() => { latest.current = props; registryRef.current = registry; });

  const fullscreen = Boolean(props.fullscreen) && popoverSupported() && kept !== undefined;

  const post = useCallback((message: unknown) => {
    const target = frameRef.current?.contentWindow;
    if (target && alive.current && !stopped) target.postMessage(message, "*");
  }, [stopped]);

  const activated = () => {
    const frame = frameRef.current;
    return frame !== null && document.activeElement === frame && navigator.userActivation?.isActive === true;
  };

  useImperativeHandle(handleRef, () => ({
    post,
    hasUserActivation: activated,
    width: () => Math.round(boxRef.current?.getBoundingClientRect().width ?? 0),
    size: () => {
      const rect = frameRef.current?.getBoundingClientRect();
      return { width: Math.round(rect?.width ?? 0), height: Math.round(rect?.height ?? 0) };
    },
  }), [post]);

  useLayoutEffect(() => {
    if (stopped) return;
    const receive = (event: MessageEvent) => {
      const source = frameRef.current?.contentWindow;
      if (!source || event.source !== source) return;
      alive.current = true;
      const key = readFrameKeyDown(event.data);
      if (!key) { latest.current.onMessage(event.data); return; }
      // Replayed on the frame element, it reaches the window listeners the way a key outside would.
      const replay = registryRef.current && activated() ? replayableKey(registryRef.current, key) : undefined;
      if (replay) frameRef.current?.dispatchEvent(replay);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [stopped]);

  useEffect(() => {
    if (loaded && !stopped) post({ type: FRAME_SCHEME_MESSAGE, scheme });
  }, [loaded, stopped, scheme, post]);

  // The document passes on only the chords named here; a later binding change reaches it too.
  useEffect(() => {
    if (!registry || !loaded || stopped) return;
    let sent = "";
    const send = () => {
      const chords = frameChords(registry);
      const next = JSON.stringify(chords);
      if (next === sent) return;
      sent = next;
      post({ type: FRAME_KEYS_MESSAGE, chords });
    };
    send();
    return registry.subscribeRegistrations(send);
  }, [registry, loaded, stopped, post]);

  const hasBox = kept !== undefined;
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !wantsWidth) return;
    const report = (width: number) => latest.current.onWidth?.(Math.round(width));
    if (typeof ResizeObserver === "undefined") { report(box.getBoundingClientRect().width); return; }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) report(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [hasBox, wantsWidth]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!fullscreen || !box) return;
    try { box.showPopover(); } catch { /* Already shown or not connected. */ }
    return () => { try { box.hidePopover(); } catch { /* Gone with its element. */ } };
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    const leave = () => latest.current.onFullscreenChange?.(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) leave(); };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !boxRef.current?.contains(event.target)) leave();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("focusin", onFocus); };
  }, [fullscreen]);

  if (!kept) return null;

  const onLoad = () => {
    loads.current += 1;
    if (loads.current === 1) { alive.current = true; setLoaded(true); return; }
    if (stopped) return;
    setStopped(true);
    props.onStopped?.();
  };

  return (
    <div className="sandbox-frame" style={{ height: clampFrameHeight(props.height ?? FRAME_DEFAULT_HEIGHT, props.minHeight) }}>
      <div
        ref={boxRef}
        className="sandbox-frame-box"
        {...(popoverSupported() ? { popover: "manual" as const } : {})}
        data-bordered={bordered ? "" : undefined}
        data-sandbox-frame-fullscreen={fullscreen ? "" : undefined}
      >
        {fullscreen ? (
          <div className="sandbox-frame-header">
            <span className="sandbox-frame-label">{props.label}</span>
            <button
              type="button"
              className="sandbox-frame-exit"
              aria-label="Exit full screen"
              {...tooltipProps("Exit full screen", { side: "bottom" })}
              onClick={() => props.onFullscreenChange?.(false)}
            ><Minimize2 size={14} /></button>
          </div>
        ) : null}
        {stopped ? (
          <p className="sandbox-frame-notice" role="status">{props.stoppedLabel ?? "This page left its document and was stopped"}</p>
        ) : (
          <iframe
            ref={frameRef}
            className="sandbox-frame-view"
            title={title}
            src={kept}
            sandbox="allow-scripts allow-forms"
            allow={frameAllowAttribute(permissions)}
            referrerPolicy="no-referrer"
            style={{ colorScheme: scheme }}
            onLoad={onLoad}
          />
        )}
      </div>
    </div>
  );
}
