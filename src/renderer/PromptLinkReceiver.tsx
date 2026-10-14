import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { HostSnapshot } from "../shared/contracts";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import type { ThreadStore } from "../workbench/thread-store";
import type { WorkbenchActions } from "./extension-system";
import { retryableLazy } from "./components/LazyFeature";
import { useHostClient } from "./host-client-context";
import { usePlatform } from "./platform-context";
import { PROMPT_LINK_EVENT } from "./prompt-link-event";

const Handler = retryableLazy(() => import("./PromptLinkHandler").then((module) => ({ default: module.PromptLinkHandler })));

export interface PromptLinkContext {
  actions: WorkbenchActions;
  threads: ThreadStore;
  snapshot?: HostSnapshot;
  scope?: string;
}

/** Listening costs no parser, draft workflow or dialog until a link arrives. */
export function PromptLinkReceiver(props: PromptLinkContext) {
  const client = useHostClient();
  const { storage } = usePlatform();
  const next = useRef(0);
  const [links, setLinks] = useState<Array<{ id: number; href: string }>>([]);
  const done = useCallback(() => setLinks((queue) => queue.slice(1)), []);
  useEffect(() => {
    let live = true;
    const receive = (href: string) => {
      if (!live) return;
      const link = { id: next.current++, href };
      setLinks((queue) => [...queue, link]);
    };
    const route = () => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("prompt")) return;
      receive(`tau://new?${url.searchParams}`);
      for (const key of ["prompt", "project", "provider", "model", "promptTruncated"]) url.searchParams.delete(key);
      window.history.replaceState(window.history.state, "", url);
    };
    const take = () => void client?.windowAction({ kind: "take-links" }).then((urls) => {
      if (Array.isArray(urls)) for (const href of urls) if (typeof href === "string") receive(href);
    }).catch(() => undefined);
    const stop = client?.onHostEvent((event) => { if (event.type === "window-shell" && event.event.kind === "links-available") take(); });
    const clicked = (event: Event) => { const href: unknown = (event as CustomEvent).detail; if (typeof href === "string") receive(href); };
    const start = setTimeout(() => {
      const pending = storage.get(STORAGE_KEYS.promptLinkArrival);
      if (pending) { storage.remove(STORAGE_KEYS.promptLinkArrival); receive(pending); }
      route(); take();
    }, 0);
    window.addEventListener("popstate", route);
    window.addEventListener(PROMPT_LINK_EVENT, clicked);
    return () => { live = false; clearTimeout(start); stop?.(); window.removeEventListener("popstate", route); window.removeEventListener(PROMPT_LINK_EVENT, clicked); };
  }, [client, storage]);
  const link = links[0];
  return link ? <Suspense fallback={null}><Handler key={link.id} {...props} href={link.href} onDone={done} /></Suspense> : null;
}
