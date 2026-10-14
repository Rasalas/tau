import { useEffect, useRef, useState } from "react";
import type { HostBootstrap } from "../shared/contracts";
import { flushBootstrapCache } from "../workbench/bootstrap-cache";
import type { ClientStorage } from "../workbench/client-storage";
import type { HostClient } from "../workbench/host-client";
import { followOpenPrompts } from "../workbench/open-prompts";
import { followWorkbenchBootstrap } from "../workbench/workbench-bootstrap";
import type { WorkbenchSession } from "../workbench/workbench-session";

/** Confirms the visible chat across startup and reconnect, and flushes its saved checkpoint. */
export function useWorkbenchStartup(
  client: HostClient | undefined,
  workbench: WorkbenchSession,
  storage: ClientStorage,
  onError: (message: string) => void,
  openStartDraft: (bootstrap: HostBootstrap) => void,
): "loading" | "offline" | "current" {
  const [freshness, setFreshness] = useState<"loading" | "offline" | "current">(client ? "loading" : "current");
  const loaded = useRef(!client);
  useEffect(() => {
    const flush = () => flushBootstrapCache(storage);
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [storage]);
  useEffect(() => {
    if (!client) return;
    let connected = true;
    const stopPrompts = followOpenPrompts(client, workbench.view);
    const stopFreshness = client.onConnectionState((state) => {
      if (state === "connected" && connected) return;
      connected = state === "connected";
      setFreshness(connected ? "loading" : "offline");
    });
    const stopConfirmation = workbench.hostSession.onConfirmed(() => {
      if (!connected) return;
      loaded.current = true;
      setFreshness("current");
    });
    const stopBootstrap = followWorkbenchBootstrap(client, workbench, onError, (bootstrap) => {
      const firstLoad = !loaded.current;
      loaded.current = true;
      setFreshness("current");
      if (firstLoad) openStartDraft(bootstrap);
    });
    return () => { stopBootstrap(); stopPrompts(); stopFreshness(); stopConfirmation(); };
  }, [client, workbench, onError, openStartDraft]);
  return freshness;
}
