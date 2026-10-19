import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useClientEnvironment, type ClientEnvironment } from "../client-environment";

export interface MediaResource { url: string; mimeType: string; release?: () => void; mainCheckoutPath?: string; resolvedPath?: string }
export type MediaLoader = (path: string) => Promise<MediaResource>;
export const isPlayableFile = (path: string) => /\.(?:mp4|m4v|webm|ogv|mov|mp3|wav|ogg|oga|opus|m4a|aac|flac|pdf)$/iu.test(path);

/** A resource belongs to its originating host and is released when its viewer closes. */
export function FileMedia({ path, load, onLoad }: { path: string; load?: MediaLoader; onLoad?(resource: MediaResource | undefined): void }) {
  const environment = useClientEnvironment();
  const [state, setState] = useState<{ path: string; load: MediaLoader; resource?: MediaResource; error?: string }>();
  useEffect(() => {
    onLoad?.(undefined);
    if (!load) return;
    let cancelled = false;
    let resource: MediaResource | undefined;
    void load(path).then((result) => {
      resource = result;
      if (cancelled) result.release?.();
      else { setState({ path, load, resource: result }); onLoad?.(result); }
    }, (error: unknown) => { if (!cancelled) setState({ path, load, error: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; resource?.release?.(); };
  }, [path, load, onLoad]);
  const current = state?.path === path && state.load === load ? state : undefined;
  if (!load || current?.error) return <div className="stage-empty" role="status">{current?.error || "This machine does not support media previews. Update Tau on it and try again."}</div>;
  if (!current?.resource) return <div className="stage-empty" role="status">Loading media…</div>;
  const { url, mimeType } = current.resource;
  const name = path.split("/").pop() || path;
  const failed = () => setState({ path, load, error: "This media could not be played. The format may not be supported by this device." });
  if (mimeType.startsWith("video/")) return <div className="stage-image"><video src={url} controls preload="metadata" aria-label={name} onError={failed} /></div>;
  if (mimeType.startsWith("audio/")) return <div className="stage-image"><audio src={url} controls preload="metadata" aria-label={name} onError={failed} /></div>;
  if (mimeType === "application/pdf") return <PdfDocument url={url} name={name} open={environment.openDocument} />;
  return <div className="stage-empty" role="status">Unsupported media type.</div>;
}

/** Some web views draw no PDF in a frame; those clients hand the file to the system viewer instead. */
function PdfDocument({ url, name, open }: { url: string; name: string; open?: ClientEnvironment["openDocument"] }) {
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!open) return <iframe className="stage-media-document" src={url} title={name} />;
  const show = () => {
    setBusy(true);
    setProblem(undefined);
    open({ url, name, mimeType: "application/pdf" }).catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  };
  return <div className="stage-empty" role="status">
    <span>This app cannot show a PDF inside the page. Open it in a PDF app on this device.</span>
    <button type="button" className="text-button" disabled={busy} onClick={show}><ExternalLink size={12} aria-hidden="true" /> Open in…</button>
    {problem ? <span role="alert">{problem}</span> : null}
  </div>;
}
