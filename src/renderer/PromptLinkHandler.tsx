import { useEffect, useRef, useState } from "react";
import type { HostSnapshot } from "../shared/contracts";
import { parsePromptLink, promptLinkParams, type PromptLink } from "../shared/prompt-links";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import type { ThreadStore } from "../workbench/thread-store";
import { useHostClient } from "./host-client-context";
import { usePlatform } from "./platform-context";
import type { WorkbenchActions } from "./extension-system";
import { ConfirmDialog } from "./deferred-surfaces";
import { placePromptLink } from "./prompt-link-flow";

const LINK_EVENT = "tau:open-prompt-link";
export function openPromptLink(href: string): void {
  window.dispatchEvent(new CustomEvent(LINK_EVENT, { detail: href }));
}

/** The same draft placement for native OS links, phone routes and transcript links. */
export function PromptLinkHandler({ actions, threads, snapshot, scope }: { actions: WorkbenchActions; threads: ThreadStore; snapshot?: HostSnapshot; scope?: string }) {
  const client = useHostClient();
  const platform = usePlatform();
  const latest = useRef({ actions, snapshot, scope });
  latest.current = { actions, snapshot, scope };
  const queue = useRef(Promise.resolve());
  const [question, setQuestion] = useState<{ answer(value: boolean): void }>();
  useEffect(() => {
    let live = true;
    let cancel: (() => void) | undefined;
    const current = new Proxy({} as WorkbenchActions, { get: (_target, key) => Reflect.get(latest.current.actions, key) });
    const receive = (link: PromptLink) => {
      queue.current = queue.current.then(async () => {
        if (!live) return;
        const environments = platform.environments;
        if (link.hostId && environments) {
          for (let attempt = 0; attempt < 80 && !environments.getSnapshot(); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          if (!live) return;
          const list = environments.getSnapshot();
          if (list?.shown !== link.hostId) {
            const machine = list?.environments.find((entry) => entry.id === link.hostId);
            if (machine?.status !== "connected") {
              current.notify("The machine in this prompt link is not available. Connect it in Settings → Machines first.", "warning");
              return;
            }
            const query = promptLinkParams(link);
            query.set("host", link.hostId);
            platform.storage.set(STORAGE_KEYS.promptLinkArrival, `tau://new?${query}`);
            try { await environments.open(link.hostId); }
            catch { platform.storage.remove(STORAGE_KEYS.promptLinkArrival); current.notify("The linked machine could not be opened.", "warning"); }
            return;
          }
        }
        await placePromptLink(link, {
          actions: current, cancelled: () => !live, scope: () => latest.current.scope, projects: () => threads.getProjects(),
          models: async () => {
            const kind = current.activeThread()?.backendKind;
            const catalog = kind ? await client?.runtimeCatalog(kind) : undefined;
            return catalog?.models ?? latest.current.snapshot?.models ?? [];
          },
          confirm: () => new Promise<boolean>((resolve) => {
            const answer = (value: boolean) => { cancel = undefined; setQuestion(undefined); resolve(value); };
            cancel = () => resolve(false);
            setQuestion({ answer });
          }),
          wait: () => new Promise((resolve) => setTimeout(resolve, 25)),
        });
      }).catch(() => { if (live) current.notify("The prompt link could not be opened.", "warning"); });
    };
    const fromUrl = () => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("prompt")) return;
      const link = parsePromptLink(`tau://new?${url.searchParams}`);
      if (link) receive(link);
      for (const key of ["prompt", "project", "provider", "model", "promptTruncated"]) url.searchParams.delete(key);
      window.history.replaceState(window.history.state, "", url);
    };
    const fromEvent = (event: Event) => {
      const href: unknown = (event as CustomEvent).detail;
      const link = typeof href === "string" ? parsePromptLink(href) : undefined;
      if (link) receive(link);
    };
    const take = () => {
      void client?.windowAction({ kind: "take-links" }).then((urls) => {
        if (!live || !Array.isArray(urls)) return;
        for (const url of urls) { const link = typeof url === "string" ? parsePromptLink(url) : undefined; if (link) receive(link); }
      }).catch(() => undefined);
    };
    const stop = client?.onHostEvent((event) => { if (event.type === "window-shell" && event.event.kind === "links-available") take(); });
    const start = setTimeout(() => {
      const pending = platform.storage.get(STORAGE_KEYS.promptLinkArrival);
      if (pending) {
        platform.storage.remove(STORAGE_KEYS.promptLinkArrival);
        const link = parsePromptLink(pending);
        if (link) receive(link);
      }
      fromUrl(); take();
    }, 0);
    window.addEventListener("popstate", fromUrl);
    window.addEventListener(LINK_EVENT, fromEvent);
    return () => { clearTimeout(start); live = false; cancel?.(); stop?.(); window.removeEventListener("popstate", fromUrl); window.removeEventListener(LINK_EVENT, fromEvent); };
  }, [client, platform, threads]);
  return question ? <ConfirmDialog title="Replace draft text?" message="This link contains a prepared prompt. Replace the text you have already written?" confirmLabel="Replace text" onConfirm={() => question.answer(true)} onCancel={() => question.answer(false)} /> : null;
}
