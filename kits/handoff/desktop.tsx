import { useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import { ArrowRightLeft, ChevronRight, CornerUpLeft, GitFork, Undo2, X } from "lucide-react";
import {
  HostUnavailableError,
  Markdown,
  Menu,
  errorMessage,
  tooltipProps,
  useThreadStore,
  type ComposerInlineProps,
  type DesktopExtension,
  type HostExtensionClient,
  type MessageBlockProps,
  type PreferencesStore,
  type RegionProps,
  type UiRuntimeBackend,
  type WorkbenchActions,
} from "tau";
import {
  HANDOFF_EXTENSION_ID,
  HANDOFF_TAG,
  LINEAGE_EVENT,
  MERGE_BACK_TAG,
  NATIVE_FORK_RUNTIMES,
  splitBlock,
  type CreateTransferResult,
  type PrepareMergeBackResult,
  type ResolveTransferResult,
} from "./protocol.js";
import { HandoffStore, parseSaved } from "./store.js";

const PROFILES = ["desktop", "web", "compact"] as const;

function runtimeLabel(kind: string, runtimes: readonly UiRuntimeBackend[]): string {
  return runtimes.find((runtime) => runtime.kind === kind)?.label ?? kind;
}

function isNative(source: string | undefined, target: string): boolean {
  return source === target && NATIVE_FORK_RUNTIMES.includes(target);
}

/** The thread on screen, when it is one that exists. */
function currentThread(actions: WorkbenchActions): { sessionId: string; workspace?: string; backendKind?: string } | undefined {
  const active = actions.activeThread();
  if (!active?.sessionId || active.draftPending) return undefined;
  const workspace = active.workspaceId ?? active.cwd;
  return { sessionId: active.sessionId, ...(workspace ? { workspace } : {}), ...(active.backendKind ? { backendKind: active.backendKind } : {}) };
}

/** A handoff or merge-back block of a user message, folded like a divider until opened. */
function contextCard(label: string, Icon: ComponentType<{ size?: number }>) {
  return function ContextCard({ body, complete }: MessageBlockProps) {
    const [open, setOpen] = useState(false);
    const { header, summary } = splitBlock(body);
    return (
      <section className="handoff-card" aria-label={label}>
        <button type="button" className="handoff-card-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <Icon size={13} />
          <strong>{label}</strong>
          <span className="handoff-card-from">{header.replace(/:$/u, "")}</span>
          <ChevronRight size={13} className="handoff-card-chevron" />
        </button>
        {open ? <div className="handoff-card-body"><Markdown streaming={!complete}>{summary || "_No summary._"}</Markdown></div> : null}
      </section>
    );
  };
}

/**
 * Handoff Kit's desktop half: "Continue in…" makes a fork on another runtime
 * whose first prompt carries a handoff, and "Bring back to parent" puts what a
 * fork or a sub-agent did into its parent's composer. `store` is injectable for tests.
 */
export function createHandoffExtension(store = new HandoffStore()): DesktopExtension {
  return {
    id: HANDOFF_EXTENSION_ID,
    name: "Handoff",
    activate(context) {
      const host: HostExtensionClient = context.host;
      const preferences: PreferencesStore = context.preferences;
      const cancel = (transferId: string) => { void host.invoke("cancel-transfer", { transferId }).catch(() => undefined); };

      const continueIn = async (target: string, actions: WorkbenchActions): Promise<void> => {
        store.openPicker(undefined);
        const thread = currentThread(actions);
        if (!thread) {
          actions.notify("Open a thread to continue it elsewhere.");
          return;
        }
        try {
          const created = await host.invoke("create-transfer", { threadId: thread.sessionId, target }) as CreateTransferResult;
          if (created.native) {
            // The runtime forks its own history; the host names the fork when it is written.
            if (!await actions.duplicateThread()) cancel(created.transferId);
            return;
          }
          preferences.setNewThreadRuntime(target);
          store.arm({ transferId: created.transferId, sourceTitle: created.sourceTitle });
          actions.newSession(thread.workspace ? { workspace: thread.workspace } : undefined);
        } catch (error) {
          actions.notify(errorMessage(error));
        }
      };

      const bringBack = async (actions: WorkbenchActions): Promise<void> => {
        const thread = currentThread(actions);
        if (!thread) {
          actions.notify("Open the fork or the sub-agent's thread to bring it back.");
          return;
        }
        const toast = actions.toast?.({ type: "loading", title: "Bringing it back", description: "Summarizing what this thread did…", timeoutMs: 0 });
        try {
          const prepared = await host.invoke("prepare-merge-back", { threadId: thread.sessionId }) as PrepareMergeBackResult;
          const parent = store.threads?.getSnapshot().threads.find((entry) => entry.id === prepared.parentThreadId);
          if (!parent) throw new Error("The parent thread is not in the thread list any more.");
          store.setMergeDraft({ parentThreadId: prepared.parentThreadId, text: prepared.context });
          toast?.dismiss();
          await actions.switchSession(parent.path);
        } catch (error) {
          toast?.dismiss();
          actions.notify(errorMessage(error));
        }
      };

      /** Before the title: where the thread came from, where it went, and the "Continue in…" menu. */
      function LineageTitle({ snapshot, actions }: RegionProps) {
        const threads = useThreadStore();
        const index = useSyncExternalStore(threads.subscribe, threads.getSnapshot);
        const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
        const [forksOpen, setForksOpen] = useState(false);
        const sessionId = snapshot?.sessionId;
        useEffect(() => {
          store.threads = threads;
          store.setRuntimes(snapshot?.runtimeBackends);
        });
        // A merge-back waits for its parent to be the thread on screen, then goes into that composer for review.
        useEffect(() => {
          const pending = view.mergeDraft;
          if (!pending || !sessionId || pending.parentThreadId !== sessionId || actions.activeThread()?.sessionId !== sessionId) return;
          store.setMergeDraft(undefined);
          const typed = actions.composerDraft().trim();
          actions.setComposerDraft?.(typed ? `${pending.text}\n\n${typed}` : `${pending.text}\n\n`);
          actions.focusComposer();
        }, [view.mergeDraft, sessionId, actions]);
        if (!sessionId) return null;
        const link = view.lineage.links.find((entry) => entry.threadId === sessionId);
        const parentId = link?.parentThreadId ?? index.threads.find((thread) => thread.id === sessionId)?.parentThreadId;
        const parent = parentId ? index.threads.find((thread) => thread.id === parentId) : undefined;
        const forks = view.lineage.links.flatMap((entry) => {
          if (entry.parentThreadId !== sessionId) return [];
          const thread = index.threads.find((candidate) => candidate.id === entry.threadId);
          return thread ? [{ link: entry, thread }] : [];
        });
        const picking = view.pickerFor === sessionId;
        if (!parentId && forks.length === 0 && !picking) return null;
        const runtimes = view.runtimes.length > 0 ? view.runtimes : [{ kind: "pi", label: "Pi" }];
        return (
          <span className="handoff-lineage">
            {link ? (
              <button
                type="button"
                className="handoff-parent"
                disabled={!parent}
                {...tooltipProps(`Continued from “${parent?.title ?? "a thread that is gone"}”${link.strategy === "native" ? ", forked natively" : ", with a handoff summary"}`)}
                onClick={() => { if (parent) void actions.switchSession(parent.path); }}
              >
                <CornerUpLeft size={12} aria-hidden="true" />
                <span>{parent?.title ?? "Parent thread"}</span>
              </button>
            ) : null}
            {parentId ? (
              <button
                type="button"
                className="handoff-icon"
                aria-label="Bring back to parent"
                {...tooltipProps(`Bring back to “${parent?.title ?? "the parent"}”`)}
                onClick={() => void bringBack(actions)}
              >
                <Undo2 size={13} />
              </button>
            ) : null}
            {forks.length > 0 ? (
              <span className="menu-anchor">
                <button
                  type="button"
                  className="handoff-forks"
                  aria-expanded={forksOpen}
                  aria-label={`${forks.length} ${forks.length === 1 ? "fork" : "forks"}`}
                  {...tooltipProps("Continued in")}
                  onClick={() => setForksOpen((value) => !value)}
                >
                  <GitFork size={12} aria-hidden="true" />
                  {forks.length}
                </button>
                {forksOpen ? (
                  <Menu
                    align="left"
                    heading="Continued in"
                    items={forks.map(({ link: fork, thread }) => ({ id: thread.id, label: thread.title, hint: runtimeLabel(fork.targetBackend, runtimes) }))}
                    onSelect={(id) => {
                      const thread = forks.find((fork) => fork.thread.id === id)?.thread;
                      if (thread) void actions.switchSession(thread.path);
                    }}
                    onClose={() => setForksOpen(false)}
                  />
                ) : null}
              </span>
            ) : null}
            {picking ? (
              <span className="menu-anchor">
                <Menu
                  align="left"
                  heading="Continue in"
                  items={runtimes.map((runtime) => ({
                    id: runtime.kind,
                    label: runtime.label,
                    description: isNative(snapshot?.backendKind ?? "pi", runtime.kind)
                      ? "A fork of this thread: the history comes along."
                      : "A new thread; a small model hands over a summary when you send.",
                    ...(runtime.kind === (snapshot?.backendKind ?? "pi") ? { badge: "This thread" } : {}),
                  }))}
                  onSelect={(kind) => void continueIn(kind, actions)}
                  onClose={() => store.openPicker(undefined)}
                />
              </span>
            ) : null}
          </span>
        );
      }

      /** The handoff a new thread's draft carries, until it is sent. */
      function HandoffChip({ scope, draftState }: ComposerInlineProps) {
        const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
        useEffect(() => {
          if (!scope.startsWith("new:")) return;
          const saved = parseSaved(draftState.read());
          const armed = store.takeArmed();
          const handoff = armed ?? saved;
          if (!handoff) return;
          if (armed && saved && saved.transferId !== armed.transferId) cancel(saved.transferId);
          if (armed) draftState.write(armed);
          store.bindDraft(scope, handoff, () => draftState.write(undefined));
          // The draft's slot is read once per scope; later writes come from here.
        }, [scope]);
        const draft = view.drafts[scope];
        if (!draft) return null;
        const status = draft.status === "writing"
          ? "Writing the handoff…"
          : draft.status === "failed" ? draft.error ?? "The handoff could not be written." : "A summary goes with your first message.";
        return (
          <div className={`handoff-chip${draft.status === "failed" ? " failed" : ""}`} role="group" aria-label="Handoff">
            <ArrowRightLeft size={13} aria-hidden="true" />
            <span className="handoff-chip-label">Continues <strong>{draft.sourceTitle}</strong></span>
            <span className="handoff-chip-status">{status}</span>
            <button
              type="button"
              aria-label="Start without the handoff"
              {...tooltipProps("Start without the handoff")}
              disabled={draft.status === "writing"}
              onClick={() => {
                const transferId = store.releaseDraft(scope, false);
                if (transferId) cancel(transferId);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      }

      const apply = (payload: unknown) => store.setLineage(payload);
      context.host.onEvent(LINEAGE_EVENT, apply);
      void host.invoke("state").then(apply).catch((error: unknown) => {
        if (!(error instanceof HostUnavailableError)) console.warn("Handoff Kit could not read the thread lineage", error);
      });

      context.registerRegion({ id: "handoff.lineage", placement: "thread-title", order: 60, profiles: PROFILES, Component: LineageTitle });
      context.registerComposerInline({
        id: "handoff.draft",
        profiles: PROFILES,
        Component: HandoffChip,
        hasContent: (scope) => Boolean(store.draft(scope)),
        subscribe: store.subscribe,
        // Lazy: the summary is written only now, so the user could still edit the draft and its model.
        prepareSend: async ({ scope }) => {
          const draft = store.draft(scope);
          if (!draft) return undefined;
          store.setDraftStatus(scope, "writing");
          try {
            const resolved = await host.invoke("resolve-transfer", { transferId: draft.transferId }) as ResolveTransferResult;
            store.setDraftStatus(scope, "waiting");
            return { context: resolved.context };
          } catch (error) {
            store.setDraftStatus(scope, "failed", errorMessage(error));
            throw error;
          }
        },
        settleSend: (scope, accepted) => { if (accepted) store.releaseDraft(scope, true); },
      });
      context.registerMessageBlock({ id: "handoff.context", tag: HANDOFF_TAG, roles: ["user"], profiles: PROFILES, Component: contextCard("Context handoff", ArrowRightLeft) });
      context.registerMessageBlock({ id: "handoff.merge-back", tag: MERGE_BACK_TAG, roles: ["user"], profiles: PROFILES, Component: contextCard("Brought back", Undo2) });
      context.registerPromptHook({
        id: "handoff.link",
        async afterPrompt(event) {
          const threadId = event.snapshot?.sessionId;
          if (!threadId) return;
          if (event.prompt.includes(`<${HANDOFF_TAG}>`)) {
            const transferId = store.nextAwaiting();
            if (transferId) store.setLineage(await host.invoke("bind-transfer", { transferId, threadId }));
          }
          // The host knows which merge-backs wait for this thread; whichever window sent it.
          if (event.prompt.includes(`<${MERGE_BACK_TAG}>`)) store.setLineage(await host.invoke("commit-merge-back", { parentThreadId: threadId }));
        },
      });
      context.registerCommand({
        id: "handoff.continue-in",
        label: "Continue in…",
        group: "Thread",
        // From the model picker, with the runtime the user pointed at.
        surfaces: ["thread-title", "runtime-switch"],
        run: (actions, target) => {
          if (target?.runtime) return continueIn(target.runtime, actions);
          const thread = currentThread(actions);
          if (thread) store.openPicker(thread.sessionId);
          else actions.notify("Open a thread to continue it elsewhere.");
        },
      });
      context.registerCommand({
        id: "handoff.bring-back",
        label: "Bring back to parent",
        group: "Thread",
        surfaces: ["thread-title"],
        run: (actions) => bringBack(actions),
      });
      context.registerPaletteSource({
        id: "handoff.continue",
        label: "Continue in",
        order: 40,
        search: (query, { actions }) => {
          const thread = currentThread(actions);
          const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
          if (!thread || words.length === 0) return [];
          return store.getSnapshot().runtimes.flatMap((runtime) => {
            const label = `Continue in ${runtime.label}`;
            if (!words.every((word) => label.toLowerCase().includes(word))) return [];
            return [{
              id: runtime.kind,
              label,
              detail: isNative(thread.backendKind ?? "pi", runtime.kind) ? "fork with its history" : "with a handoff summary",
              run: (next: WorkbenchActions) => continueIn(runtime.kind, next),
            }];
          });
        },
      });
      return () => store.clear();
    },
  };
}

export default createHandoffExtension();
