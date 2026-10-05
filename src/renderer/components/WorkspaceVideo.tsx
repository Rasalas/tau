import { useEffect, useState } from "react";
import { RESOURCE_UNAVAILABLE, transcriptFilePath, useWorkspaceResources, type WorkspaceResources } from "../workspace-resource-context";
import { MessageImageGallery } from "./MessageImages";

export const isVideoPath = (path: string) => /\.(?:mp4|m4v|webm|ogv|mov)(?:[?#].*)?$/iu.test(path);

/** Embedded chat videos open the lightbox; Markdown file links keep opening the stage. */
export function WorkspaceVideo({ src, alt = "Video" }: { src: string; alt?: string }) {
  const resources = useWorkspaceResources();
  const external = /^https?:\/\//iu.test(src) || /^data:video\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/iu.test(src);
  const [result, setResult] = useState<{ resources: WorkspaceResources; src: string; url?: string; error?: string }>();
  useEffect(() => {
    if (external || !resources?.available || !resources.loadMedia) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    const load = async () => {
      try {
        const path = transcriptFilePath(decodeURIComponent(src), resources.displayPath);
        const media = await resources.loadMedia!(path);
        release = media.release;
        if (cancelled) { release?.(); return; }
        if (!media.mimeType.startsWith("video/")) throw new Error("This file is not a video.");
        setResult({ resources, src, url: media.url });
      } catch (error) { if (!cancelled) setResult({ resources, src, error: error instanceof Error ? error.message : String(error) }); }
    };
    void load();
    return () => { cancelled = true; release?.(); };
  }, [external, resources, src]);
  const current = result && result.resources === resources && result.src === src ? result : undefined;
  const url = external ? src : current?.url;
  if (url) return <MessageImageGallery origin="from the conversation" images={[{ key: src, kind: "video", src: url, alt, label: alt }]} />;
  return <span role="status">{current?.error || (resources?.available ? "Loading video…" : RESOURCE_UNAVAILABLE)}</span>;
}
