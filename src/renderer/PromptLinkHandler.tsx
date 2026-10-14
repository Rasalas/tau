import { useEffect, useRef, useState } from "react";
import { parsePromptLink, promptLinkParams } from "../shared/prompt-links";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { useHostClient } from "./host-client-context";
import { usePlatform } from "./platform-context";
import type { WorkbenchActions } from "./extension-system";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import type { PromptLinkContext } from "./PromptLinkReceiver";
import { placePromptLink } from "./prompt-link-flow";

/** The same draft placement for native OS links, phone routes and transcript links. */
export function PromptLinkHandler({ actions, threads, snapshot, scope, href, onDone }: PromptLinkContext & { href: string; onDone(): void }) {
  const client = useHostClient();
  const platform = usePlatform();
  const latest = useRef({ actions, snapshot, scope });
  latest.current = { actions, snapshot, scope };
  const [question, setQuestion] = useState<{ answer(value: boolean): void }>();
  useEffect(() => {
    let live = true;
    let cancel: (() => void) | undefined;
    const current = new Proxy({} as WorkbenchActions, { get: (_target, key) => Reflect.get(latest.current.actions, key) });
    const link = parsePromptLink(href);
    void Promise.resolve().then(async () => {
      if (link) {
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
      }
    }).catch(() => { if (live) current.notify("The prompt link could not be opened.", "warning"); }).finally(() => { if (live) onDone(); });
    return () => { live = false; cancel?.(); };
  }, [client, platform, threads, href, onDone]);
  return question ? <ConfirmDialog title="Replace draft text?" message="Replace your draft with the linked prompt?" confirmLabel="Replace text" onConfirm={() => question.answer(true)} onCancel={() => question.answer(false)} /> : null;
}
