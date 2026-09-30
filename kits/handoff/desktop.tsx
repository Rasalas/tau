import { useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import { ArrowRightLeft, ChevronRight, CornerUpLeft, GitFork, Laptop, Monitor, Server, Undo2, X } from "lucide-react";
import {
  HostUnavailableError,
  Markdown,
  Menu,
  READ_ONLY_REASON,
  errorMessage,
  hostCommandAllowed,
  tooltipProps,
  useCommandAllowed,
  useThreadStore,
  type ComposerInlineProps,
  type DesktopExtension,
  type HostExtensionClient,
  type MenuItem,
  type MenuSection,
  type MessageBlockProps,
  type PreferencesStore,
  type RegionProps,
  type UiRuntimeBackend,
  type UiSession,
  type WorkbenchActions,
} from "tau";
import {
  HANDOFF_EXTENSION_ID,
  HANDOFF_TAG,
  LINEAGE_EVENT,
  MERGE_BACK_TAG,
  NATIVE_FORK_RUNTIMES,
  TARGETS_EVENT,
  splitBlock,
  type ContinueOnResult,
  type ContinueTarget,
  type CreateTransferResult,
  type PrepareMergeBackResult,
  type RemoteContinuation,
  type ResolveTransferResult,
} from "./protocol.js";
import { REMOTE_WORK_EXTENSION_ID, THREAD_LINK_EVENT, type RemoteThreadLink } from "../remote-work/protocol.js";
import type { ThreadDropTarget, WorkspaceStoreApi } from "../workspace/protocol.js";
import { HandoffStore, parseSaved } from "./store.js";

const PROFILES = ["desktop", "web", "compact"] as const;

function runtimeLabel(kind: string, runtimes: readonly UiRuntimeBackend[]): string {
  return runtimes.find((runtime) => runtime.kind === kind)?.label ?? kind;
}

function isNative(source: string | undefined, target: string): boolean {
  return source === target && NATIVE_FORK_RUNTIMES.includes(target);
}

const MACHINE_ITEM = "machine:";
const WORKSPACE_STORE_SERVICE = "tau.workspace/store";

/**
 * Why a thread on `backend` cannot continue on `target` now, or undefined.
 * A machine that could not say what runs there is offered anyway; the host checks again.
 */
function unavailableOn(target: ContinueTarget, backend: string, runtimes: readonly UiRuntimeBackend[], draft: string): string | undefined {
  const runtime = target.runtimes?.find((entry) => entry.kind === backend);
  if (target.runtimes && !runtime) return `${target.name} has no ${runtimeLabel(backend, runtimes)}.`;
  if (runtime && !runtime.ready) return `${runtime.label} is ${runtime.note ?? "not ready"} on ${target.name}.`;
  if (!NATIVE_FORK_RUNTIMES.includes(backend) && !draft.trim()) return `Write what ${target.name} should do next in the composer first.`;
  return undefined;
}

function continueOnDescription(backend: string): string {
  return NATIVE_FORK_RUNTIMES.includes(backend)
    ? "Goes on there with its history and your draft; you stay here."
    : "A new thread there with a handoff summary and your draft; you stay here.";
}

function remoteStatus(link: RemoteThreadLink | undefined): string {
  switch (link?.status) {
    case undefined: return "";
    case "sending": return "Sending the project";
    case "starting": return "Starting";
    case "running": return "Working";
    case "waiting": return link.there?.question ? `Asks: ${link.there.question}` : "Waiting for an answer";
    case "idle": return "Idle";
    case "failed": return link.thread ? `Failed: ${link.error ?? "the last turn failed"}` : `Never started: ${link.error ?? "unknown reason"}`;
    case "offline": return "Offline · may still be running";
    case "gone": return "Deleted there";
    case "settled": return "Settled";
  }
}

/** "Continue in": the runtimes here, then the machines the thread could go on on. */
function pickerSections(backend: string, runtimes: readonly UiRuntimeBackend[], targets: readonly ContinueTarget[], draft: string): MenuSection[] {
  const here: MenuItem[] = runtimes.map((runtime) => ({
    id: runtime.kind,
    label: runtime.label,
    description: isNative(backend, runtime.kind)
      ? "A fork of this thread: the history comes along."
      : "A new thread; a small model hands over a summary when you send.",
    ...(runtime.kind === backend ? { badge: "This thread" } : {}),
  }));
  const elsewhere: MenuItem[] = targets.map((target) => {
    const why = unavailableOn(target, backend, runtimes, draft);
    return {
      id: `${MACHINE_ITEM}${target.id}`,
      label: target.name,
      description: why ?? continueOnDescription(backend),
      ...(why ? { disabled: true } : {}),
    };
  });
  return [{ heading: "Continue in", items: here }, ...(elsewhere.length > 0 ? [{ heading: "On another machine", items: elsewhere }] : [])];
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
      const remoteWork = context.hostExtension(REMOTE_WORK_EXTENSION_ID);
      const environments = context.environments;
      const refreshTargets = () => { void host.invoke("continue-targets", { refresh: true }).then((targets) => store.setTargets(targets), () => undefined); };

      /** Shows the machine in this window, at the thread when its list names it; the window's own choice (ADR 0025). */
      const openThere = async (remote: Pick<RemoteContinuation, "link" | "machine" | "machineName">, actions: WorkbenchActions): Promise<void> => {
        if (!environments) {
          actions.notify(`Open ${remote.machineName} from the desktop app; this client keeps no list of machines.`);
          return;
        }
        try {
          const thread = store.getSnapshot().remoteLinks[remote.link]?.thread;
          const listed = thread ? environments.getSnapshot()?.environments.find((entry) => entry.id === remote.machine)?.threads.find((entry) => entry.id === thread) : undefined;
          // A thread past the list's newest is found by its id there (API 1.15.0).
          await environments.open(remote.machine, listed ? { thread: { path: listed.path } } : thread ? { threadId: thread } : undefined);
        } catch (error) {
          actions.notify(errorMessage(error));
        }
      };

      // Out of sight: the window stays on this thread, and a toast says where it went.
      // `threadId` is a thread dragged onto the machine; only the one on screen takes the draft along.
      const continueOn = async (machine: string, actions: WorkbenchActions, threadId?: string): Promise<void> => {
        store.openPicker(undefined);
        const shown = currentThread(actions);
        const thread = threadId ? { sessionId: threadId } : shown;
        if (!thread) {
          actions.notify("Open a thread to continue it elsewhere.");
          return;
        }
        const draft = thread.sessionId === shown?.sessionId ? actions.composerDraft().trim() : "";
        const name = store.getSnapshot().targets.find((target) => target.id === machine)?.name ?? machine;
        const toast = actions.toast?.({ type: "loading", title: `Continuing on ${name}`, description: "Sending the project's state and the thread…", timeoutMs: 0 });
        try {
          const result = await host.invoke("continue-on", { threadId: thread.sessionId, machine, ...(draft ? { prompt: draft } : {}) }) as ContinueOnResult;
          if (draft && actions.activeThread()?.sessionId === thread.sessionId && actions.composerDraft().trim() === draft) actions.setComposerDraft?.("");
          const description = result.native
            ? `It goes on there with its history${draft ? " and your message" : ""}; this thread stays usable here.`
            : "A new thread there starts with a handoff summary and your message; this thread stays usable here.";
          const open = { label: `Open on ${result.machineName}`, run: () => void openThere({ link: result.link, machine: result.machine, machineName: result.machineName }, actions) };
          if (toast) toast.update({ type: "success", title: `Continues on ${result.machineName}`, description, timeoutMs: 8_000, ...(environments ? { actions: [open] } : {}) });
          else actions.notify(`Continues on ${result.machineName}.`);
        } catch (error) {
          toast?.dismiss();
          actions.notify(errorMessage(error));
        }
      };

      const bringBackRemote = async (remote: RemoteContinuation, actions: WorkbenchActions): Promise<void> => {
        const toast = actions.toast?.({ type: "loading", title: `Bringing it back from ${remote.machineName}`, description: "Fetching its branch and a summary…", timeoutMs: 0 });
        try {
          const prepared = await host.invoke("bring-back-remote", { threadId: remote.threadId }) as PrepareMergeBackResult;
          toast?.dismiss();
          store.setMergeDraft({ parentThreadId: remote.threadId, text: prepared.context });
        } catch (error) {
          toast?.dismiss();
          actions.notify(errorMessage(error));
        }
      };

      const settleRemote = async (remote: RemoteContinuation, how: "apply" | "discard", actions: WorkbenchActions): Promise<void> => {
        try {
          const link = await host.invoke("settle-remote", { threadId: remote.threadId, how }) as RemoteThreadLink;
          store.setRemoteLink(link);
          if (link.status === "settled") {
            actions.toast?.({ type: "success", title: how === "apply" ? `Merged from ${remote.machineName}` : `Let go of the work on ${remote.machineName}`, ...(link.settled?.detail ? { description: link.settled.detail } : {}) });
            return;
          }
          const conflict = link.applied?.state === "conflict";
          actions.toast?.({
            type: conflict ? "warning" : "error",
            title: conflict ? "Nothing merged: it conflicts" : "Nothing merged",
            ...(link.applied?.detail ? { description: link.applied.detail } : {}),
            ...(link.applied?.files.length ? { copyText: link.applied.files.join("\n") } : {}),
            timeoutMs: 0,
          });
        } catch (error) {
          actions.notify(errorMessage(error));
        }
      };

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
        const mayBringBack = useCommandAllowed(HANDOFF_EXTENSION_ID, "prepare-merge-back");
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
                disabled={!mayBringBack}
                {...tooltipProps(mayBringBack ? `Bring back to “${parent?.title ?? "the parent"}”` : READ_ONLY_REASON)}
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
                  sections={pickerSections(snapshot?.backendKind ?? "pi", runtimes, view.targets, actions.composerDraft())}
                  onSelect={(id) => void (id.startsWith(MACHINE_ITEM) ? continueOn(id.slice(MACHINE_ITEM.length), actions) : continueIn(id, actions))}
                  onClose={() => store.openPicker(undefined)}
                />
              </span>
            ) : null}
          </span>
        );
      }

      /**
       * Above the composer of a thread that continues on another machine:
       * where and how it is doing, "Open" there, "Bring back" its branch and
       * summary, then "Merge". The thread here stays usable meanwhile.
       */
      function RemoteBanner({ snapshot, actions }: RegionProps) {
        const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
        const [busy, setBusy] = useState<"back" | "merge" | "discard">();
        const [confirming, setConfirming] = useState(false);
        const mayChange = useCommandAllowed(HANDOFF_EXTENSION_ID, "bring-back-remote");
        const sessionId = snapshot?.sessionId;
        const remote = store.remote(sessionId);
        useEffect(() => setConfirming(false), [remote?.link]);
        if (!remote || actions.activeThread()?.sessionId !== sessionId) return null;
        const link = view.remoteLinks[remote.link];
        if (link?.status === "settled") return null;
        const working = link?.status === "sending" || link?.status === "starting" || link?.status === "running";
        const result = link?.result?.state === "branch" ? link.result : undefined;
        const run = (what: "back" | "merge" | "discard", work: () => Promise<void>) => {
          setBusy(what);
          void work().finally(() => { setBusy(undefined); setConfirming(false); });
        };
        const status = remoteStatus(link);
        if (confirming) {
          return (
            <div className="handoff-remote" role="region" aria-label={`Let go of the work on ${remote.machineName}`}>
              <Server size={13} aria-hidden="true" />
              <span className="handoff-remote-text">Let go of the work on <strong>{remote.machineName}</strong>? {working ? "Its turn stops and its" : "Its"} worktree there is removed; nothing comes back here.</span>
              <span className="handoff-remote-actions">
                <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => run("discard", () => settleRemote(remote, "discard", actions))}>{busy === "discard" ? "Letting go…" : "Let go"}</button>
                <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
              </span>
            </div>
          );
        }
        const conflict = link?.applied?.state === "conflict" || link?.applied?.state === "blocked" ? link.applied : undefined;
        return (
          <div className="handoff-remote" role="region" aria-label={`Continues on ${remote.machineName}`}>
            <Server size={13} aria-hidden="true" />
            <span className="handoff-remote-text">
              Continues on <strong>{remote.machineName}</strong>
              {status ? <span className={`handoff-remote-status${link?.status === "failed" || link?.status === "offline" ? " warn" : ""}`}> · {status}</span> : null}
              {result ? <span className="handoff-remote-branch" {...tooltipProps(`${result.commits} ${result.commits === 1 ? "commit" : "commits"}, ${result.files} ${result.files === 1 ? "file" : "files"}`)}> · {result.branch}</span> : null}
              {conflict ? <span className="handoff-remote-status warn" {...tooltipProps(conflict.detail)}> · {conflict.state === "conflict" ? `Conflicts in ${conflict.files.length} ${conflict.files.length === 1 ? "file" : "files"}` : "Blocked"}; nothing merged</span> : null}
            </span>
            <span className="handoff-remote-actions">
              {environments?.watchThread && link?.thread ? (
                <button
                  type="button"
                  {...tooltipProps(`Read it in a tab here; the window stays on this machine`)}
                  onClick={() => actions.openThread(link.thread!, { pin: true, machine: remote.machine })}
                >Look in</button>
              ) : null}
              {environments ? (
                <button type="button" {...tooltipProps(`Show ${remote.machineName} in this window, at the thread, to answer or steer it there`)} onClick={() => void openThere(remote, actions)}>Open on {remote.machineName}</button>
              ) : null}
              <button
                type="button"
                disabled={!mayChange || working || !link?.thread || Boolean(busy)}
                {...tooltipProps(!mayChange ? READ_ONLY_REASON : working ? `Wait until it is idle on ${remote.machineName}` : `Its branch and a summary of what happened there go into the composer`)}
                onClick={() => run("back", () => bringBackRemote(remote, actions))}
              >
                {busy === "back" ? "Bringing back…" : "Bring back"}
              </button>
              {result ? (
                <button
                  type="button"
                  className="primary"
                  disabled={!mayChange || working || Boolean(busy)}
                  {...tooltipProps(`Merges ${result.branch} here when it is clean, then removes the worktree on ${remote.machineName}`)}
                  onClick={() => run("merge", () => settleRemote(remote, "apply", actions))}
                >
                  {busy === "merge" ? "Merging…" : "Merge"}
                </button>
              ) : null}
              <button type="button" className="handoff-remote-close" aria-label={`Let go of the work on ${remote.machineName}`} disabled={!mayChange || Boolean(busy)} {...tooltipProps(mayChange ? "Let go" : READ_ONLY_REASON)} onClick={() => setConfirming(true)}>
                <X size={12} />
              </button>
            </span>
          </div>
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

      /**
       * The machines a thread dragged in the rail can go to (design 2f): this one
       * dimmed, the others as "Continue on" would take them, or why not.
       */
      const dropTargets = (thread: UiSession, actions: WorkbenchActions): ThreadDropTarget[] => {
        const machines = environments?.getSnapshot()?.environments;
        if (!machines || machines.length < 2 || !hostCommandAllowed(HANDOFF_EXTENSION_ID, "continue-on")) return [];
        const view = store.getSnapshot();
        const draft = actions.activeThread()?.sessionId === thread.id ? actions.composerDraft() : "";
        return machines.map((machine) => {
          const target = view.targets.find((entry) => entry.id === machine.id);
          const running = machine.threads.filter((entry) => entry.running).length;
          const why = machine.local ? "here already"
            : machine.status !== "connected" ? machine.status
            : !target ? "its agents may not work there"
            : unavailableOn(target, thread.backendKind ?? "pi", view.runtimes, draft);
          return {
            id: machine.id,
            label: machine.name,
            icon: machine.local ? <Laptop size={14} /> : <Monitor size={14} />,
            detail: why ?? `online · ${running ? `${running} running` : "idle"} · sends the worktree first`,
            ...(why ? { disabled: true } : {}),
          };
        });
      };
      context.useService<Pick<WorkspaceStoreApi, "registerThreadDropTargets">>(WORKSPACE_STORE_SERVICE, (workspace) => workspace.registerThreadDropTargets?.({
        heading: "Drop to move the thread",
        targets: dropTargets,
        // The host continues only an open thread, so a thread from further down the list opens first.
        drop: (thread, machine, actions) => void (async () => {
          if (actions.activeThread()?.sessionId === thread.id || await actions.switchSession(thread.path)) await continueOn(machine, actions, thread.id);
        })(),
      }));

      // A link no event brought yet (a reload, another window's continuation) is asked for once.
      const apply = (payload: unknown) => {
        store.setLineage(payload);
        for (const id of store.missingLinks()) void remoteWork.invoke("thread", { link: id }).then((link) => store.setRemoteLink(link), () => undefined);
      };
      context.host.onEvent(LINEAGE_EVENT, apply);
      context.host.onEvent(TARGETS_EVENT, (targets) => store.setTargets(targets));
      remoteWork.onEvent(THREAD_LINK_EVENT, (link) => store.setRemoteLink(link));
      void host.invoke("continue-targets").then((targets) => store.setTargets(targets), () => undefined);
      void host.invoke("state").then(apply).catch((error: unknown) => {
        if (!(error instanceof HostUnavailableError)) console.warn("Handoff Kit could not read the thread lineage", error);
      });

      context.registerRegion({ id: "handoff.lineage", placement: "thread-title", order: 60, profiles: PROFILES, Component: LineageTitle });
      context.registerRegion({ id: "handoff.remote", placement: "composer-above", order: 40, profiles: PROFILES, Component: RemoteBanner });
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
        access: "write",
        // From the model picker, with the runtime the user pointed at.
        surfaces: ["thread-title", "runtime-switch"],
        run: (actions, target) => {
          if (target?.runtime) return continueIn(target.runtime, actions);
          const thread = currentThread(actions);
          if (!thread) {
            actions.notify("Open a thread to continue it elsewhere.");
            return;
          }
          store.openPicker(thread.sessionId);
          refreshTargets();
        },
      });
      context.registerCommand({
        id: "handoff.bring-back",
        label: "Bring back to parent",
        group: "Thread",
        access: "write",
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
          if (!thread || words.length === 0 || !hostCommandAllowed(HANDOFF_EXTENSION_ID, "create-transfer")) return [];
          const matches = (label: string) => words.every((word) => label.toLowerCase().includes(word));
          const view = store.getSnapshot();
          const backend = thread.backendKind ?? "pi";
          const machines = hostCommandAllowed(HANDOFF_EXTENSION_ID, "continue-on") ? view.targets.flatMap((target) => {
            const label = `Continue on ${target.name}`;
            if (!matches(label) || unavailableOn(target, backend, view.runtimes, actions.composerDraft())) return [];
            return [{
              id: `${MACHINE_ITEM}${target.id}`,
              label,
              detail: NATIVE_FORK_RUNTIMES.includes(backend) ? "with its history" : "with a handoff summary",
              access: "write" as const,
              run: (next: WorkbenchActions) => continueOn(target.id, next),
            }];
          }) : [];
          return [...view.runtimes.flatMap((runtime) => {
            const label = `Continue in ${runtime.label}`;
            if (!matches(label)) return [];
            return [{
              id: runtime.kind,
              label,
              detail: isNative(thread.backendKind ?? "pi", runtime.kind) ? "fork with its history" : "with a handoff summary",
              access: "write" as const,
              run: (next: WorkbenchActions) => continueIn(runtime.kind, next),
            }];
          }), ...machines];
        },
      });
      return () => store.clear();
    },
  };
}

export default createHandoffExtension();
