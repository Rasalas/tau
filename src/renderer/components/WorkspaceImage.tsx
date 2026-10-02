import { useEffect, useState } from "react";
import { RESOURCE_UNAVAILABLE, resourceRelativePath, useWorkspaceResources, type WorkspaceResources } from "../workspace-resource-context";

// Only raster data images can come back from an authorized workspace read.
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon);base64,[A-Za-z0-9+/=\s]+$/iu;

interface ImageResult {
  resources: WorkspaceResources;
  path: string;
  dataUrl?: string;
  error?: string;
}

function UnavailableImage({ name, reason }: { name: string; reason: string }) {
  return <span role="img" aria-label={`${name}: ${reason}`}>{name}: {reason}</span>;
}

/** Relative Markdown images are files of the transcript's origin, not this device. */
export function WorkspaceImage({ src = "", alt = "", title, width, height }: { src?: string; alt?: string; title?: string; width?: number | string; height?: number | string }) {
  const resources = useWorkspaceResources();
  const [result, setResult] = useState<ImageResult>();
  const [failedSource, setFailedSource] = useState<string>();
  const external = /^https?:\/\//iu.test(src) || DATA_IMAGE.test(src);
  let path: string | undefined;
  if (src && !external && !/^[A-Za-z][A-Za-z0-9+.-]*:|^[/?#]/u.test(src)) {
    try { path = resourceRelativePath(decodeURIComponent(src)); } catch { /* Draw guidance instead of a browser URL. */ }
  }

  useEffect(() => {
    if (!path || !resources?.available) return;
    let cancelled = false;
    const finish = (value: ImageResult) => { if (!cancelled) setResult(value); };
    void resources.loadFile(path).then((file) => {
      if (file.kind !== "image" || file.truncated || !file.dataUrl || !DATA_IMAGE.test(file.dataUrl)) {
        finish({ resources, path, error: "This file is not a supported image or is too large to display." });
      } else finish({ resources, path, dataUrl: file.dataUrl });
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /not found|ENOENT|unknown|not a known/iu.test(message) ? "Image not found in this workspace."
        : /denied|forbidden|permission/iu.test(message) ? "Image access denied."
        : /offline|disconnect|not connected/iu.test(message) ? "Image host offline. Reconnect to load it."
        : /unsupported|not support/iu.test(message) ? "Image reads are not supported by this host."
        : /size|large|limit/iu.test(message) ? "Image too large to display."
        : "The workspace image could not be loaded.";
      finish({ resources, path, error: reason });
    });
    return () => { cancelled = true; };
  }, [path, resources]);

  const name = alt || path?.split("/").pop() || "Image";
  if (external) {
    if (failedSource === src) return <UnavailableImage name={name} reason="The image could not be displayed." />;
    return <img src={src} alt={alt} title={title} width={width} height={height} onError={() => setFailedSource(src)} />;
  }
  if (!path) return <UnavailableImage name={name} reason="Name an image by its path inside the thread's workspace." />;
  if (!resources?.available) return <UnavailableImage name={name} reason={RESOURCE_UNAVAILABLE} />;
  // Never paint a previous path/origin's bytes while its replacement loads.
  const current = result?.resources === resources && result.path === path ? result : undefined;
  if (current?.dataUrl) {
    return <img src={current.dataUrl} alt={alt} title={title} width={width} height={height} onError={() => setResult({ resources, path, error: "The workspace image could not be decoded." })} />;
  }
  return <UnavailableImage name={name} reason={current?.error || "Loading workspace image…"} />;
}
