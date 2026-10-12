import { useEffect, useRef, useState } from "react";
import { Maximize2, PanelRightOpen } from "lucide-react";
import { SandboxFrame, errorMessage, tooltipProps, useClientEnvironment, useColorScheme, type HostExtensionClient, type SandboxFrameHandle, type WorkbenchActions } from "tau";
import { HTML_PAGE_COMMANDS, HTML_PAGE_STAGE_TAB, type HtmlPageOpen, type HtmlPageOpenInput } from "./protocol.js";
import { pageTheme } from "./theme.js";

type View =
  | { kind: "opening" }
  | { kind: "ready"; src: string; open: Extract<HtmlPageOpen, { state: "ready" }> }
  | { kind: "unavailable"; reason: string };

const fullscreenSupported = () => typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

const SIZE_METHOD = "ui/notifications/size-changed";
const LINK_METHOD = "ui/open-link";

interface Message { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

/** The page's own report of its content height, when `data` is one. */
export function reportedHeight(data: unknown): number | undefined {
  const message = data as Message | null;
  if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0" || message.method !== SIZE_METHOD) return undefined;
  const height = (message.params as { height?: unknown } | undefined)?.height;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

/** A clicked http(s) link the page handed over, with the id its answer needs. */
export function linkRequest(data: unknown): { id: string | number; url: string } | undefined {
  const message = data as Message | null;
  if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0" || message.method !== LINK_METHOD) return undefined;
  if (typeof message.id !== "string" && typeof message.id !== "number") return undefined;
  const url = (message.params as { url?: unknown } | undefined)?.url;
  return typeof url === "string" && /^https?:\/\//iu.test(url) ? { id: message.id, url } : undefined;
}

export interface PageViewProps {
  host: HostExtensionClient;
  actions: WorkbenchActions;
  threadId: string;
  pageId: string;
  /** `card` sits in the transcript and sizes itself to the page; `tab` fills the stage tab. */
  variant: "card" | "tab";
  /** Called once the host answered, with the page's title. */
  onTitle?(title: string): void;
}

/** One stored page in a sandbox frame, with the controls around it. */
export function PageView({ host, actions, threadId, pageId, variant, onTitle }: PageViewProps) {
  const scheme = useColorScheme();
  const environment = useClientEnvironment();
  const [view, setView] = useState<View>({ kind: "opening" });
  const [height, setHeight] = useState<number | undefined>();
  const [fullscreen, setFullscreen] = useState(false);
  const [room, setRoom] = useState(0);
  const handle = useRef<SandboxFrameHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ scheme, onTitle });
  latest.current = { scheme, onTitle };

  useEffect(() => {
    let cancelled = false;
    let minted: string | undefined;
    const release = () => {
      if (minted === undefined) return;
      const path = minted;
      minted = undefined;
      void host.invoke(HTML_PAGE_COMMANDS.release, { path }).catch(() => undefined);
    };
    const input: HtmlPageOpenInput = { threadId, id: pageId, colorScheme: latest.current.scheme, theme: pageTheme() };
    host.invoke(HTML_PAGE_COMMANDS.open, input).then((answer) => {
      const open = answer as HtmlPageOpen;
      if (open.state === "ready") minted = open.path;
      if (cancelled) { release(); return; }
      if (open.state === "missing") { setView({ kind: "unavailable", reason: "This page is no longer stored." }); return; }
      if (!host.resourceUrl) { release(); setView({ kind: "unavailable", reason: "This client cannot show pages." }); return; }
      latest.current.onTitle?.(open.title);
      setView({ kind: "ready", src: host.resourceUrl(open.path), open });
    }, (error: unknown) => { if (!cancelled) setView({ kind: "unavailable", reason: errorMessage(error) }); });
    return () => { cancelled = true; release(); };
  }, [host, threadId, pageId]);

  // A tab gives the page the room it has; the box exists once the page is ready.
  useEffect(() => {
    const element = box.current;
    if (variant !== "tab" || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setRoom(element.clientHeight));
    observer.observe(element);
    setRoom(element.clientHeight);
    return () => observer.disconnect();
  }, [variant, view.kind]);

  const onMessage = (data: unknown) => {
    const measured = reportedHeight(data);
    if (measured !== undefined) {
      if (!fullscreen) setHeight(Math.ceil(measured));
      return;
    }
    const link = linkRequest(data);
    if (!link) return;
    const allowed = Boolean(handle.current?.hasUserActivation());
    if (allowed) actions.openExternal(link.url);
    handle.current?.post(allowed
      ? { jsonrpc: "2.0", id: link.id, result: {} }
      : { jsonrpc: "2.0", id: link.id, error: { code: -32000, message: "Links open only from a click in the page." } });
  };

  if (view.kind === "opening") return <p className="html-page-reason" role="status">Opening the page…</p>;
  if (view.kind === "unavailable") return <p className="html-page-reason">{view.reason}</p>;

  const { open } = view;
  const frameHeight = variant === "tab" ? room : Math.min(height ?? open.maxHeight, open.maxHeight);
  const canTab = variant === "card" && environment.profile !== "compact" && typeof actions.openStageTab === "function";
  return (
    <div className="html-page-body" data-variant={variant} ref={box}>
      {variant === "card" ? (
        <div className="html-page-bar">
          <span className="html-page-title">{open.title}</span>
          {open.origins.length > 0 ? <span className="html-page-origins" {...tooltipProps(`Loads from ${open.origins.join(", ")}`)}>{open.origins.length === 1 ? new URL(open.origins[0]!).host : `${String(open.origins.length)} hosts`}</span> : null}
          <span className="html-page-actions">
            {fullscreenSupported() ? (
              <button type="button" className="html-page-button" aria-label="Expand" {...tooltipProps("Expand")} onClick={() => setFullscreen(true)}><Maximize2 size={14} aria-hidden="true" /></button>
            ) : null}
            {canTab ? (
              <button type="button" className="html-page-button" aria-label="Open in a tab" {...tooltipProps("Open in a tab")} onClick={() => actions.openStageTab(HTML_PAGE_STAGE_TAB, { threadId, id: pageId, title: open.title })}><PanelRightOpen size={14} aria-hidden="true" /></button>
            ) : null}
          </span>
        </div>
      ) : null}
      <SandboxFrame
        src={view.src}
        title={open.title}
        height={frameHeight}
        fullscreen={fullscreen}
        onFullscreenChange={setFullscreen}
        onMessage={onMessage}
        label={open.title}
        handleRef={handle}
      />
    </div>
  );
}
