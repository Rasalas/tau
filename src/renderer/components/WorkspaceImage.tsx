import { useMediaGallery } from "./MediaGallery";
import { AttachmentLightbox } from "../deferred-surfaces";
import { MediaLinkContext } from "./media-link-context";
import { RemoteMediaButton, remoteHost } from "./RemoteMedia";
import { useContext, useEffect, useState } from "react";
import { useClientEnvironment } from "../client-environment";
import { RESOURCE_UNAVAILABLE, resourceRelativePath, transcriptFilePath, useWorkspaceResources, type WorkspaceResources } from "../workspace-resource-context";

// Only raster data images can come back from an authorized workspace read.
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon);base64,[A-Za-z0-9+/=\s]+$/iu;
const RASTER_IMAGE = /^image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon)$/iu;

// Native sockets pin certificates and may travel through a relay; ordinary
// image URLs cannot use that connection. Keep their file replies sequential
// so several base64 images cannot fill the host's send buffer at once.
const imageReads = new WeakMap<WorkspaceResources, Promise<void>>();
function readImageFile(resources: WorkspaceResources, path: string, cancelled: () => boolean) {
  const request = (imageReads.get(resources) ?? Promise.resolve()).then(() => cancelled() ? undefined : resources.loadFile(path));
  const settled = request.then(() => undefined, () => undefined);
  imageReads.set(resources, settled);
  void settled.then(() => { if (imageReads.get(resources) === settled) imageReads.delete(resources); });
  return request;
}

interface ImageResult {
  resources: WorkspaceResources;
  path: string;
  url?: string;
  error?: string;
}

function UnavailableImage({ name, reason }: { name: string; reason: string }) {
  return <span role="img" aria-label={`${name}: ${reason}`}>{name}: {reason}</span>;
}

interface ImageProps {
  src: string;
  alt: string;
  title?: string;
  width?: number | string;
  height?: number | string;
}

function PreviewImage({ src, alt, title, width, height, onError }: ImageProps & { onError(): void }) {
  const [open, setOpen] = useState(false);
  const linked = useContext(MediaLinkContext);
  const images = [{ key: src, src, alt, label: title || alt || "Image" }];
  const gallery = useMediaGallery(images, !linked);
  if (linked) return <img src={src} alt={alt} title={title} width={width} height={height} onError={onError} />;
  return <span ref={gallery.ref}><button type="button" className="md-image-link" aria-label={`Open ${alt || "image"}`} onClick={() => gallery.open ? gallery.open(0) : setOpen(true)}><img src={src} alt={alt} title={title} width={width} height={height} onError={onError} /></button>
    {open ? <AttachmentLightbox images={[{ key: src, src, alt, label: title || alt || "Image" }]} index={0} onClose={() => setOpen(false)} /> : null}</span>;
}

function RemoteImage(props: ImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const host = remoteHost(props.src);
  if (!host) return <UnavailableImage name={props.alt || "Image"} reason="The image URL is invalid." />;
  if (failed) return <UnavailableImage name={props.alt || "Image"} reason="The image could not be displayed." />;
  if (loaded) return <PreviewImage {...props} onError={() => setFailed(true)} />;
  return <RemoteMediaButton kind="image" host={host} alt={props.alt} onLoad={() => setLoaded(true)} />;
}

/** Relative Markdown images are files of the transcript's origin, not this device. */
export function WorkspaceImage({ src = "", alt = "", title, width, height }: { src?: string; alt?: string; title?: string; width?: number | string; height?: number | string }) {
  const resources = useWorkspaceResources();
  const environment = useClientEnvironment();
  const compact = environment.profile !== "desktop";
  const resourceImages = compact && !environment.mobileApp;
  const [result, setResult] = useState<ImageResult>();
  const [failedSource, setFailedSource] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const external = /^https?:\/\//iu.test(src) || DATA_IMAGE.test(src);
  let path: string | undefined;
  if (src && !external && !/^[A-Za-z][A-Za-z0-9+.-]*:|^[/]{2}|^[?#]/u.test(src)) {
    try { const decoded = decodeURIComponent(src); path = decoded.startsWith("/") && resources?.displayPath ? transcriptFilePath(decoded, resources.displayPath) : resourceRelativePath(decoded); } catch { /* Draw guidance instead of a browser URL. */ }
  }

  useEffect(() => {
    if (!path || !resources?.available) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    const finish = (value: ImageResult) => { if (!cancelled) setResult(value); };
    const load = async () => {
      // Resource URLs belong to the connected host. Routed images retain the
      // file read that carries their bytes back from the other machine.
      if (resourceImages && resources.loadMedia && resources.local !== false) {
        const media = await resources.loadMedia(path);
        if (cancelled || !RASTER_IMAGE.test(media.mimeType)) {
          media.release?.();
          if (!cancelled) finish({ resources, path, error: "This file is not a supported image." });
          return;
        }
        release = media.release;
        finish({ resources, path, url: media.url });
        return;
      }
      const file = await (compact ? readImageFile(resources, path, () => cancelled) : resources.loadFile(path));
      if (!file) return;
      if (file.kind !== "image" || file.truncated || !file.dataUrl || !DATA_IMAGE.test(file.dataUrl)) {
        finish({ resources, path, error: "This file is not a supported image or is too large to display." });
      } else finish({ resources, path, url: file.dataUrl });
    };
    void load().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /not found|ENOENT|unknown|not a known/iu.test(message) ? "Image not found in this workspace."
        : /denied|forbidden|permission/iu.test(message) ? "Image access denied."
        : /offline|disconnect|not connected/iu.test(message) ? "The machine is offline. Reconnect to load the image."
        : /unsupported|not support/iu.test(message) ? "Image reads are not supported by this machine."
        : /size|large|limit/iu.test(message) ? "Image too large to display."
        : "The workspace image could not be loaded.";
      finish({ resources, path, error: reason });
    });
    return () => { cancelled = true; release?.(); };
  }, [attempt, compact, path, resourceImages, resources]);

  const name = alt || path?.split("/").pop() || "Image";
  // A changed URL, including its query, must not inherit a previous image's consent.
  if (/^https?:\/\//iu.test(src)) return <RemoteImage key={src} src={src} alt={alt} title={title} width={width} height={height} />;
  if (external) {
    if (failedSource === src) return <UnavailableImage name={name} reason="The image could not be displayed." />;
    return <PreviewImage src={src} alt={alt} title={title} width={width} height={height} onError={() => setFailedSource(src)} />;
  }
  if (!path) return <UnavailableImage name={name} reason="Name an image by its path inside the thread's workspace." />;
  if (!resources?.available) return <UnavailableImage name={name} reason={RESOURCE_UNAVAILABLE} />;
  // Never paint a previous path/origin's bytes while its replacement loads.
  const current = result?.resources === resources && result.path === path ? result : undefined;
  if (current?.url) {
    return <PreviewImage src={current.url} alt={alt} title={title} width={width} height={height} onError={() => setResult({ resources, path, error: "The workspace image could not be decoded." })} />;
  }
  return <span><UnavailableImage name={name} reason={current?.error || "Loading workspace image…"} />
    {current?.error ? <> <button type="button" className="text-button" aria-label={`Retry ${name}`} onClick={() => { setResult(undefined); setAttempt((value) => value + 1); }}>Retry</button></> : null}</span>;
}
