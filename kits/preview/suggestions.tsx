import { useEffect, useRef, useState } from "react";
import { Server } from "lucide-react";
import type { PreviewServer } from "./protocol.js";
import { previewKit } from "./store.js";

/** `localhost:8000` and what serves it. */
export function serverLabel(server: PreviewServer): { address: string; detail: string } {
  const address = server.url.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
  const detail = [server.command, server.inWorkspace ? "this project" : ""].filter(Boolean).join(" · ");
  return { address, detail };
}

/**
 * Local dev servers as one row of buttons under the address bar. The host
 * scans when the row appears, when the address field takes focus and when the
 * window shows again; a scan runs lsof and probes each server, so the row does
 * not poll. Nothing found draws nothing.
 */
export function PortSuggestions({ cwd, current, focused = false, onOpen }: { cwd?: string; current: string; focused?: boolean; onOpen(url: string): void }) {
  const [servers, setServers] = useState<PreviewServer[]>([]);
  const scan = useRef<() => void>(() => undefined);
  const wasFocused = useRef(focused);

  useEffect(() => {
    let live = true;
    scan.current = () => {
      if (document.hidden) return;
      void previewKit.ports({ ...(cwd ? { cwd } : {}) })
        .then((found) => { if (live && Array.isArray(found)) setServers(found); })
        .catch(() => undefined);
    };
    scan.current();
    const shows = () => scan.current();
    document.addEventListener("visibilitychange", shows);
    return () => {
      live = false;
      scan.current = () => undefined;
      document.removeEventListener("visibilitychange", shows);
    };
  }, [cwd]);

  useEffect(() => {
    if (focused && !wasFocused.current) scan.current();
    wasFocused.current = focused;
  }, [focused]);

  const shown = servers.filter((server) => !current.startsWith(server.url));
  if (shown.length === 0) return null;
  return <div className="preview-suggestions" aria-label="Local servers">
    {shown.slice(0, 6).map((server) => {
      const { address, detail } = serverLabel(server);
      return <button
        key={server.url}
        type="button"
        className="preview-suggestion"
        title={`Open ${server.url}${server.pid ? ` (pid ${server.pid})` : ""}`}
        // Keeps the address field focused, so the row does not vanish under the click.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onOpen(server.url)}
      >
        <Server size={11} aria-hidden="true" />
        <span>{address}</span>
        {detail ? <small>{detail}</small> : null}
      </button>;
    })}
  </div>;
}
