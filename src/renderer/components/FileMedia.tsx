import { useEffect, useState } from "react";

export interface MediaResource { url: string; mimeType: string; release?: () => void }
export type MediaLoader = (path: string) => Promise<MediaResource>;
export const isPlayableFile = (path: string) => /\.(?:mp4|m4v|webm|ogv|mov|mp3|wav|ogg|oga|opus|m4a|aac|flac|pdf)$/iu.test(path);

/** A resource belongs to its originating host and is released when its viewer closes. */
export function FileMedia({ path, load }: { path: string; load?: MediaLoader }) {
  const [state, setState] = useState<{ path: string; load: MediaLoader; resource?: MediaResource; error?: string }>();
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    let resource: MediaResource | undefined;
    void load(path).then((result) => {
      resource = result;
      if (cancelled) result.release?.();
      else setState({ path, load, resource: result });
    }, (error: unknown) => { if (!cancelled) setState({ path, load, error: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; resource?.release?.(); };
  }, [path, load]);
  const current = state?.path === path && state.load === load ? state : undefined;
  if (!load || current?.error) return <div className="stage-empty" role="status">{current?.error || "This host does not support media previews. Update the host and try again."}</div>;
  if (!current?.resource) return <div className="stage-empty" role="status">Loading media…</div>;
  const { url, mimeType } = current.resource;
  const name = path.split("/").pop() || path;
  const failed = () => setState({ path, load, error: "This media could not be played. The format may not be supported by this device." });
  if (mimeType.startsWith("video/")) return <div className="stage-image"><video src={url} controls preload="metadata" aria-label={name} onError={failed} /></div>;
  if (mimeType.startsWith("audio/")) return <div className="stage-image"><audio src={url} controls preload="metadata" aria-label={name} onError={failed} /></div>;
  if (mimeType === "application/pdf") return <iframe className="stage-media-document" src={url} title={name} />;
  return <div className="stage-empty" role="status">Unsupported media type.</div>;
}
