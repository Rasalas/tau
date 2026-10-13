import { useState, type ReactNode } from "react";

export const remoteHost = (src: string): string | undefined => {
  try { return new URL(src).host; } catch { return undefined; }
};

/** The only control that lets a foreign server hear from the reader: one form for every kind of remote media. */
export function RemoteMediaButton({ kind, host, alt, onLoad }: { kind: "image" | "video" | "audio"; host: string; alt?: string; onLoad(): void }) {
  return <button type="button" className="md-remote-image" aria-label={`Load ${kind} from ${host}`} onClick={(event) => {
    event.preventDefault();
    event.stopPropagation();
    onLoad();
  }}>{alt ? `${alt} · ` : ""}Load {kind} from {host}</button>;
}

function RemoteMediaGate({ src, kind, alt, children }: { src: string; kind: "video" | "audio"; alt?: string; children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const host = remoteHost(src);
  if (!host) return <span role="status">The {kind} URL is invalid.</span>;
  return loaded ? <>{children}</> : <RemoteMediaButton kind={kind} host={host} {...(alt ? { alt } : {})} onLoad={() => setLoaded(true)} />;
}

/** Mounts `children` only after a click for exactly `src`; a changed address, query included, asks again. */
export function RemoteMedia(props: { src: string; kind: "video" | "audio"; alt?: string; children: ReactNode }) {
  return <RemoteMediaGate key={props.src} {...props} />;
}
