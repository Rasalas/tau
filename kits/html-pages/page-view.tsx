import { useEffect, useRef, useState } from "react";
import { Maximize2, PanelRightOpen } from "lucide-react";
import { AttachmentLightbox, SandboxFrame, errorMessage, tooltipProps, useClientEnvironment, useColorScheme, type AttachmentImage, type HostExtensionClient, type SandboxFrameHandle, type WorkbenchActions } from "tau";
import { HTML_PAGE_COMMANDS, HTML_PAGE_STAGE_TAB, PAGE_MESSAGES, type HtmlPageOpen, type HtmlPageOpenInput } from "./protocol.js";
import { openPageLink } from "./links.js";
import { pageTheme } from "./theme.js";

type View =
  | { kind: "opening" }
  | { kind: "ready"; src: string; open: Extract<HtmlPageOpen, { state: "ready" }> }
  | { kind: "unavailable"; reason: string };

const fullscreenSupported = () => typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

const SIZE_METHOD = "ui/notifications/size-changed";
const LINK_METHOD = "ui/open-link";

interface Message { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown }

/** The page's own report of its content height, when `data` is one. */
export function reportedHeight(data: unknown): number | undefined {
  const message = data as Message | null;
  if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0" || message.method !== SIZE_METHOD) return undefined;
  const height = (message.params as { height?: unknown } | undefined)?.height;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

/** A clicked http(s) link the page handed over, with the id its answer needs and the modifiers held. */
export function linkRequest(data: unknown): { id: string | number; url: string; metaKey: boolean; ctrlKey: boolean } | undefined {
  const message = data as Message | null;
  if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0" || message.method !== LINK_METHOD) return undefined;
  if (typeof message.id !== "string" && typeof message.id !== "number") return undefined;
  const { url, metaKey, ctrlKey } = (message.params ?? {}) as { url?: unknown; metaKey?: unknown; ctrlKey?: unknown };
  return typeof url === "string" && /^https?:\/\//iu.test(url) ? { id: message.id, url, metaKey: metaKey === true, ctrlKey: ctrlKey === true } : undefined;
}

const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)(?:;[^,;]*)*;base64,/iu;
const MAX_IMAGES = 100;

/** The images a page handed over that Tau may draw (embedded, or from a declared origin), and where `selected` is among them, if it was kept. */
export function readImages(value: unknown, origins: readonly string[], fallbackLabel: string, selected = 0): { images: AttachmentImage[]; index: number | undefined } {
  const images: AttachmentImage[] = [];
  let index: number | undefined;
  for (const [position, entry] of (Array.isArray(value) ? value : []).slice(0, MAX_IMAGES).entries()) {
    const { src, alt } = (entry ?? {}) as { src?: unknown; alt?: unknown };
    if (typeof src !== "string") continue;
    let allowed = DATA_IMAGE.test(src);
    if (!allowed && /^https:\/\//iu.test(src)) { try { allowed = origins.includes(new URL(src).origin); } catch { /* Not a URL. */ } }
    if (!allowed) continue;
    if (position === selected) index = images.length;
    const text = typeof alt === "string" ? alt.trim().slice(0, 300) : "";
    images.push({ key: `${String(images.length)}:${src.slice(-32)}`, src, alt: text, label: text || fallbackLabel });
  }
  return { images, index };
}

/** A page's images and the one to show first, when `data` hands them over on a click. */
export function openImagesRequest(data: unknown): { images: unknown; index: number } | undefined {
  const message = data as Message | null;
  if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0" || message.method !== PAGE_MESSAGES.openImages) return undefined;
  const params = message.params as { images?: unknown; index?: unknown } | undefined;
  return { images: params?.images, index: typeof params?.index === "number" && Number.isInteger(params.index) ? params.index : 0 };
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
  const [gallery, setGallery] = useState(false);
  const [shown, setShown] = useState<{ images: AttachmentImage[]; index: number }>();
  const listing = useRef<string | undefined>(undefined);
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
    if (view.kind !== "ready") return;
    const message = data as Message | null;
    if (message?.jsonrpc === "2.0" && message.method === PAGE_MESSAGES.media) {
      setGallery((message.params as { gallery?: unknown } | undefined)?.gallery === true);
      return;
    }
    // A click in the page, or the answer to Expand; never a page opening the viewer by itself.
    const clicked = openImagesRequest(data);
    const answered = listing.current !== undefined && message?.id === listing.current ? (message.result as { images?: unknown } | undefined) : undefined;
    if (clicked || answered) {
      if (answered) listing.current = undefined;
      else if (!handle.current?.hasUserActivation()) return;
      const read = readImages(clicked?.images ?? answered?.images, view.open.origins, view.open.title, clicked?.index);
      if (answered && read.images.length === 0) { setFullscreen(true); return; }
      if (clicked && read.index === undefined) return;
      setFullscreen(false);
      setShown({ images: read.images, index: read.index ?? 0 });
      return;
    }
    const link = linkRequest(data);
    if (!link) return;
    const allowed = Boolean(handle.current?.hasUserActivation());
    if (allowed) openPageLink(link.url, link, actions);
    handle.current?.post(allowed
      ? { jsonrpc: "2.0", id: link.id, result: {} }
      : { jsonrpc: "2.0", id: link.id, error: { code: -32000, message: "Links open only from a click in the page." } });
  };

  if (view.kind === "opening") return <p className="html-page-reason" role="status">Opening the page…</p>;
  if (view.kind === "unavailable") return <p className="html-page-reason">{view.reason}</p>;

  const { open } = view;
  const frameHeight = variant === "tab" ? room : Math.min(height ?? open.maxHeight, open.maxHeight);
  // A page of only images opens in the image viewer; any other page goes full screen.
  const expand = () => {
    if (!gallery) { setFullscreen(true); return; }
    listing.current = `tau-images-${String(Date.now())}`;
    handle.current?.post({ jsonrpc: "2.0", id: listing.current, method: PAGE_MESSAGES.listImages });
  };
  const canTab = variant === "card" && environment.profile !== "compact" && typeof actions.openStageTab === "function";
  return (
    <div className="html-page-body" data-variant={variant} ref={box}>
      {variant === "card" ? (
        <div className="html-page-bar">
          <span className="html-page-title">{open.title}</span>
          {open.origins.length > 0 ? <span className="html-page-origins" {...tooltipProps(`Loads from ${open.origins.join(", ")}`)}>{open.origins.length === 1 ? new URL(open.origins[0]!).host : `${String(open.origins.length)} hosts`}</span> : null}
          <span className="html-page-actions">
            {gallery || fullscreenSupported() ? (
              <button type="button" className="html-page-button" aria-label="Expand" {...tooltipProps("Expand")} onClick={expand}><Maximize2 size={14} aria-hidden="true" /></button>
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
      {shown ? <AttachmentLightbox images={shown.images} index={shown.index} origin="from this page" onClose={() => setShown(undefined)} /> : null}
    </div>
  );
}
