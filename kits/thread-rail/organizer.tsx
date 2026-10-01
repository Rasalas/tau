import { AlarmClock, AlarmClockOff, Archive, ArchiveRestore, ArrowDown, ArrowRightLeft, ArrowUp, ArrowUpDown, Check, Copy, CopyPlus, CornerUpLeft, Folder, Funnel, FunnelX, GitBranch, GitFork, Hash, ListTree, MessageSquareDot, MessageSquareText, Pencil, Pin, PinOff, ScrollText, Settings, Sparkles, SquareArrowOutUpRight, SquarePen, Trash2, type LucideIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ConfirmDialog, Dialog, errorMessage, hostIsReadOnly, READ_ONLY_REASON, renameRefusal, useThreadStore, useWorkbenchShell, type MenuItem, type MenuSection, type ThreadMenuLookup, type ToastHandle, type UiSession, type WorkbenchActions } from "tau";
import {
  UNARCHIVE_PATCH,
  WAKE_PATCH,
  dropLabel,
  dropPatches,
  fallbackThread,
  inversePatch,
  nextActiveThread,
  pinPatch,
  railSections,
  sectionOf,
  settlePatch,
  snoozePatch,
  snoozePresets,
  unsettlePatch,
  type RailDrop,
} from "./meta.js";
import type { RailOrganizer, RailQuestion, RailQuestionAction, RailSections, ThreadMetaPatch, ThreadTitlesSlice, WorkspaceStoreSlice } from "./protocol.js";
import type { RailStore } from "./store.js";
import type { ThreadUndo, UndoAction, UndoKind } from "./undo.js";

/** Resolves true once the host took the change. */
export type SendPatches = (patches: Record<string, ThreadMetaPatch | null>) => Promise<boolean>;

/** What the organizer asks of the rest of the kit: the host half and the undo list. */
export interface RailOrganizerPort {
  send: SendPatches;
  undo: ThreadUndo;
  /** The host refuses a running thread. */
  archive(threadId: string): Promise<void>;
  remove(threadId: string): Promise<void>;
  restore(threadId: string): Promise<void>;
  running(threadId: string): boolean;
  /** Workspace Kit's store, for the rail's project filter and project settings. */
  workspace?(): WorkspaceStoreSlice | undefined;
  /** Thread Titles, while it is on; the row offers "Regenerate title" only then. */
  titles?(): ThreadTitlesSlice | undefined;
  /** Asks before an action the user wants confirmed; true when it may go ahead. Absent, nothing asks. */
  confirm?(action: RailQuestionAction, sessions: readonly UiSession[]): Promise<boolean>;
}

const EMPTY: RailSections = { pinned: [], active: [], snoozed: [], settled: [], archived: [] };

/** A menu item's icon; the OS's menu draws the same one by its name. */
const glyph = (Icon: LucideIcon) => ({ icon: <Icon size={13} /> });

const chord = (lookup: ThreadMenuLookup | undefined, commandId: string) => {
  const label = lookup?.keybindingLabel(commandId);
  return label ? { hint: label } : {};
};

/** Other kits' thread-title commands the menu places itself; the rail's own have items of their own. */
const PLACED: Record<string, LucideIcon | undefined> = {
  "handoff.continue-in": ArrowRightLeft,
  "handoff.bring-back": CornerUpLeft,
  "workspace.open-in-editor": SquareArrowOutUpRight,
  "thread.snooze": undefined,
  "thread.archive": undefined,
  "thread.delete": undefined,
  "thread-titles.regenerate": undefined,
  "workspace.copy-branch": undefined,
};

/** The thread on screen, when it is this one and not a pending draft. */
const onScreen = (actions: WorkbenchActions | undefined, threadId: string): boolean => {
  const active = actions?.activeThread();
  return Boolean(active && !active.draftPending && active.sessionId === threadId);
};

/** The thread the reader looks at: not a draft, and nothing (a page, a phone's list) over it. */
const inView = (actions: WorkbenchActions | undefined): string | undefined => {
  const active = actions?.activeThread();
  return active && !active.draftPending && !active.covered ? active.sessionId : undefined;
};

/** The rail as Thread Rail sees it: four sections, the row menu, drops, the snooze dialog and the undo notice. */
export function createRailOrganizer(store: RailStore, port: RailOrganizerPort, now: () => number = Date.now): RailOrganizer & {
  /** Pin or unpin, settle or un-settle, by thread id; the commands' way in. */
  togglePin(threadId: string): void;
  toggleSettledById(threadId: string, actions?: WorkbenchActions): void;
  snooze(threadId: string, until: number, actions?: WorkbenchActions): void;
  archive(session: UiSession, actions: WorkbenchActions | undefined, confirmed?: boolean): Promise<void>;
  unarchive(threadId: string): void;
  remove(session: UiSession, actions: WorkbenchActions | undefined, leaving?: ReadonlySet<string>, confirmed?: boolean): Promise<void>;
  restore(threadId: string): Promise<void>;
} {
  const { send, undo } = port;
  type Change = { threadId: string; patch: ThreadMetaPatch; kind?: UndoKind; action?: UndoAction };
  let last: RailSections = EMPTY;
  const meta = (threadId: string) => store.getState().threads[threadId];

  /** Sends the patches and, for an action the notice offers back, what takes them back. */
  const change = (patches: Record<string, ThreadMetaPatch>, record?: { threadId: string; kind: UndoKind; action: UndoAction }) => {
    const inverse = Object.fromEntries(Object.entries(patches).map(([id, patch]) => [id, inversePatch(meta(id), patch)]));
    const sent = send(patches);
    if (record) undo.record(record.kind, record.threadId, record.action, async () => { await send(inverse); });
    return sent;
  };

  /** Several threads in one write to the host; each still gets its own undo, and the notice counts them. */
  const changeMany = (changes: readonly Change[]) => {
    if (changes.length === 0) return Promise.resolve(false);
    const inverses = changes.map(({ threadId, patch }) => [threadId, inversePatch(meta(threadId), patch)] as const);
    const sent = send(Object.fromEntries(changes.map(({ threadId, patch }) => [threadId, patch])));
    changes.forEach(({ threadId, kind, action }, index) => {
      if (!kind || !action) return;
      const inverse = inverses[index]![1];
      undo.record(kind, threadId, action, async () => { await send({ [threadId]: inverse }); });
    });
    return sent;
  };

  /**
   * The move after parking the thread on screen: planned before the
   * change, taken once the host has it and only if the reader is still there.
   * The host's own settles never come through here, so they never move anyone.
   */
  const parkAndMove = (threadIds: readonly string[], actions: WorkbenchActions | undefined, park: () => Promise<boolean>) => {
    const leaving = inView(actions);
    if (!actions || !leaving || !threadIds.includes(leaving)) { void park(); return; }
    const order = actions.threadListOrder?.() ?? store.displayed.map((thread) => thread.id);
    const parking = new Set(threadIds);
    const at = now();
    const next = nextActiveThread(order, leaving, (id) => !parking.has(id) && ["pinned", "active"].includes(sectionOf(meta(id), at)));
    const target = next ? store.session(next) : undefined;
    const project = store.session(leaving);
    void park().then((parked) => {
      if (!parked || inView(store.actions ?? actions) !== leaving || ["pinned", "active"].includes(sectionOf(meta(leaving), now()))) return;
      if (target) void actions.switchSession(target.path);
      else actions.newSession(project ? { workspace: project.workspaceId ?? project.projectPath } : undefined);
    });
  };

  const ask = (action: RailQuestionAction, sessions: readonly UiSession[]) =>
    sessions.length === 0 || !port.confirm ? Promise.resolve(true) : port.confirm(action, sessions);
  const sessionOf = (threadId: string): UiSession => store.session(threadId) ?? ({ id: threadId, title: "this thread" } as UiSession);

  const togglePin = (threadId: string) => {
    const pinned = Boolean(meta(threadId)?.pinned);
    if (!pinned) {
      undo.invalidate("pin", threadId);
      void change({ [threadId]: pinPatch(store.getState(), threadId, true, now()) });
      return;
    }
    void ask("unpin", [sessionOf(threadId)]).then((confirmed) => {
      if (confirmed && meta(threadId)?.pinned) void change({ [threadId]: pinPatch(store.getState(), threadId, false, now()) }, { threadId, kind: "pin", action: "Unpinned" });
    });
  };
  const toggleSettledById = (threadId: string, actions = store.actions) => {
    if (meta(threadId)?.settledAt !== undefined) {
      undo.invalidate("settle", threadId);
      void change({ [threadId]: unsettlePatch(now()) });
    } else {
      parkAndMove([threadId], actions, () => change({ [threadId]: settlePatch(now(), "user") }, { threadId, kind: "settle", action: "Settled" }));
    }
  };
  const snooze = (threadId: string, until: number, actions = store.actions) =>
    parkAndMove([threadId], actions, () => change({ [threadId]: snoozePatch(until) }, { threadId, kind: "snooze", action: "Snoozed" }));
  const snoozeMany = (threadIds: readonly string[], until: number, actions = store.actions) =>
    parkAndMove(threadIds, actions, () => changeMany(threadIds.map((threadId) => ({ threadId, patch: snoozePatch(until), kind: "snooze" as const, action: "Snoozed" as const }))));
  const wake = (threadId: string) => {
    undo.invalidate("snooze", threadId);
    void change({ [threadId]: WAKE_PATCH });
  };
  const drop = (threadId: string, target: RailDrop) => {
    const label = dropLabel(sectionOf(meta(threadId), now()), target.sectionId);
    const patches = dropPatches(store.getState(), last, threadId, target, now());
    if (!patches) return;
    if (label === "Settle") { parkAndMove([threadId], store.actions, () => change(patches, { threadId, kind: "settle", action: "Settled" })); return; }
    void change(patches, label === "Unpin" ? { threadId, kind: "pin", action: "Unpinned" } : undefined);
  };
  /** One step up or down within the thread's own section. */
  const step = (threadId: string, direction: -1 | 1) => {
    const section = sectionOf(meta(threadId), now());
    if (section !== "pinned" && section !== "active") return;
    const list = last[section].map((thread) => thread.id);
    const index = list.indexOf(threadId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    const without = list.filter((id) => id !== threadId);
    drop(threadId, { sectionId: section, ...(without[target] ? { beforeThreadId: without[target] } : {}) });
  };

  const notify = (actions: WorkbenchActions | undefined, message: string) => { actions?.notify(message); };

  const snoozeSubmenu = (): MenuSection[] => [
    { items: snoozePresets(new Date(now())).map(({ id, label, when }) => ({ id, label, hint: when })) },
    { items: [{ id: "snooze:custom", label: "Custom…" }] },
  ];

  /** Runs an action of the thread on screen for `session`, opening it first when it is elsewhere. */
  const onThread = async (session: UiSession, actions: WorkbenchActions, run: () => unknown) => {
    if (!onScreen(actions, session.id) && !await actions.switchSession(session.path)) return;
    try {
      await run();
    } catch (error) {
      notify(actions, errorMessage(error));
    }
  };
  /** Titles are made from a thread's live runtime. */
  const regenerateTitle = (session: UiSession, actions: WorkbenchActions) => port.titles?.() && onThread(session, actions, () => port.titles?.()?.regenerate(actions));

  /** A running thread cannot be archived, and archiving the thread on screen opens a new one in its project. */
  const archive = async (session: UiSession, actions: WorkbenchActions | undefined, confirmed = false) => {
    if (port.running(session.id)) { notify(actions, "Cannot archive a running thread."); return; }
    if (!confirmed && !await ask("archive", [session])) return;
    const shown = onScreen(actions, session.id);
    try {
      await port.archive(session.id);
    } catch (error) {
      notify(actions, `Failed to archive thread: ${errorMessage(error)}`);
      return;
    }
    undo.record("archive", session.id, "Archived", async () => {
      unarchive(session.id);
      // Undo brings the reader back when archiving moved them to a draft.
      if (shown) await actions?.switchSession(session.path);
    });
    if (shown) actions?.newSession({ workspace: session.workspaceId ?? session.projectPath });
  };
  const unarchive = (threadId: string) => {
    undo.invalidate("archive", threadId);
    void change({ [threadId]: UNARCHIVE_PATCH });
  };

  /** Into the host's trash; the notice, `mod+z` and Settings → Archived bring it back. */
  /** `leaving`: threads going in the same batch, which the reader is never moved to. */
  const remove = async (session: UiSession, actions: WorkbenchActions | undefined, leaving: ReadonlySet<string> = new Set(), confirmed = false) => {
    if (port.running(session.id)) { notify(actions, "Stop the thread before deleting it."); return; }
    if (!confirmed && !await ask("delete", [session])) return;
    const shown = onScreen(actions, session.id);
    if (shown) {
      const next = fallbackThread(store.displayed.filter((thread) => !leaving.has(thread.id) || thread.id === session.id), session);
      if (!next) { notify(actions, "Open another thread before deleting this one."); return; }
      await actions?.switchSession(next.path);
    }
    try {
      await port.remove(session.id);
    } catch (error) {
      notify(actions, `Failed to delete thread: ${errorMessage(error)}`);
      return;
    }
    undo.record("delete", session.id, "Deleted", async () => {
      await port.restore(session.id);
      if (shown) await actions?.switchSession(session.path);
    });
  };
  const restore = async (threadId: string) => {
    undo.invalidate("delete", threadId);
    await port.restore(threadId);
  };

  let undoToast: ToastHandle | undefined;
  /** The undo offer, as a toast on core's stack; inline at the foot of the rail where there is no stack. */
  function UndoNotice({ actions }: { actions: WorkbenchActions }) {
    useSyncExternalStore(undo.subscribe, undo.getVersion);
    const { registry } = useWorkbenchShell();
    const notice = undo.getNotice();
    store.actions = actions;
    // A phone has no ⌘Z to name.
    const shortcut = document.body.dataset.profile === "compact" ? undefined : registry.keybindingLabel("thread.undo");
    const text = notice ? `${notice.action} ${notice.count} thread${notice.count === 1 ? "" : "s"}` : undefined;
    const toast = actions.toast;
    useEffect(() => {
      if (!toast) return;
      if (!text) { undoToast?.dismiss(); undoToast = undefined; return; }
      // Hide the confirmation promptly without shortening the keyboard undo window.
      undoToast = toast({
        id: "tau.thread-rail.undo",
        type: "success",
        title: text,
        ...(shortcut ? { description: `${shortcut} to undo` } : {}),
        timeoutMs: 2_000,
        actions: [{ label: "Undo", run: () => { undo.undo(); } }],
        onClose: () => { undoToast = undefined; },
      });
    }, [shortcut, text, toast]);
    if (toast || !text) return null;
    return (
      <div className="thread-rail-undo" role="status">
        {text},{" "}
        <button type="button" onClick={() => { undo.undo(); }}>{shortcut ? `${shortcut} to undo` : "Undo"}</button>
      </div>
    );
  }

  function Layer({ actions }: { actions: WorkbenchActions }) {
    useSyncExternalStore(store.subscribe, store.getVersion);
    // Commands and the Archived page find a thread by id through the index this client holds.
    store.threadStore = useThreadStore();
    const sessions = store.snoozeDialogFor;
    const renaming = store.renameDialogFor;
    const question = store.question;
    return (
      <>
        <UndoNotice actions={actions} />
        {question ? <RailConfirmation key={question.sessions.map((session) => session.id).join()} question={question} onDone={() => store.ask(undefined)} /> : null}
        {sessions && sessions.length > 0 ? (
          <SnoozeDialog
            key={sessions.map((session) => session.id).join()}
            sessions={sessions}
            now={now}
            onClose={() => store.openSnooze(undefined)}
            onSnooze={(until) => { snoozeMany(sessions.map((session) => session.id), until, actions); store.openSnooze(undefined); }}
          />
        ) : null}
        {renaming ? (
          <RenameDialog
            key={renaming.id}
            session={renaming}
            onClose={() => store.openRename(undefined)}
            onRename={async (title) => {
              // The host renames the thread on screen; one elsewhere is opened first.
              if (!onScreen(actions, renaming.id) && !await actions.switchSession(renaming.path)) return false;
              if (!actions.renameThread) { actions.notify("This version of Tau cannot rename threads from the rail."); return false; }
              const renamed = await actions.renameThread(title);
              if (renamed) store.openRename(undefined);
              return renamed;
            }}
          />
        ) : null}
      </>
    );
  }

  const lifecycleSection = (session: UiSession, lookup: ThreadMenuLookup | undefined): MenuSection => {
    const running = port.running(session.id);
    return {
      items: [
        { id: "archive", label: "Archive thread", ...glyph(Archive), ...chord(lookup, "thread.archive"), disabled: running, ...(running ? { description: "Cannot archive a running thread." } : {}) },
        { id: "delete", label: "Delete", ...glyph(Trash2), ...chord(lookup, "thread.delete"), destructive: true, disabled: running, ...(running ? { description: "Stop the thread before deleting it." } : {}) },
      ],
    };
  };

  return {
    rowActions(session) {
      const section = sectionOf(meta(session.id), now());
      if (section === "settled" || section === "snoozed" || hostIsReadOnly()) return [];
      return [{ id: "snooze", label: "Snooze thread", icon: <AlarmClock size={13} aria-hidden="true" />, menu: snoozeSubmenu }];
    },
    subscribe: store.subscribe,
    getVersion: store.getVersion,
    sections(threads) {
      last = railSections(threads, store.getState(), now());
      store.displayed = [...last.pinned, ...last.active];
      return [
        { id: "pinned", label: "Pinned", threads: last.pinned },
        { id: "active", threads: last.active },
        { id: "snoozed", label: "Snoozed", shelf: true, collapsed: true, threads: last.snoozed },
        { id: "settled", label: "Settled", shelf: true, collapsed: false, settled: true, threads: last.settled },
      ];
    },
    // T3 Code's thread menu, on the title and the row alike; Tau's own actions sit under Fork, Move and Copy.
    menu(session, lookup) {
      const current = meta(session.id);
      const section = sectionOf(current, now());
      const settled = section === "settled";
      const snoozed = section === "snoozed";
      const renameWhy = renameRefusal(session);
      const workspace = port.workspace?.();
      const branch = session.projectLabel;
      const filtered = workspace?.getSnapshot().railProjectFilter === session.projectName;
      const offered = lookup?.getCommandsFor("thread-title") ?? [];
      const command = (id: string): MenuItem[] => offered.filter((entry) => entry.id === id).map(commandItem);
      const commandItem = (entry: (typeof offered)[number]): MenuItem => {
        const reason = hostIsReadOnly() && entry.access !== "read" ? READ_ONLY_REASON : entry.unavailable?.();
        const Icon = PLACED[entry.id];
        return { id: `command:${entry.id}`, label: entry.label, ...(Icon ? glyph(Icon) : {}), ...chord(lookup, entry.id), ...(entry.destructive ? { destructive: true } : {}), ...(reason ? { disabled: true, description: reason } : {}) };
      };
      const others = offered.filter((entry) => !(entry.id in PLACED));
      const snoozeItems: MenuItem[] = settled ? [] : snoozed
        ? [{ id: "wake", label: "Wake thread", ...glyph(AlarmClockOff) }, { id: "snooze:custom", label: "Snooze until…", ...glyph(AlarmClock), ...chord(lookup, "thread.snooze") }]
        : [{ id: "snooze", label: "Snooze", ...glyph(AlarmClock), submenu: snoozeSubmenu() }];
      const lifecycle = lifecycleSection(session, lookup);
      lifecycle.items.splice(1, 0, ...others.filter((entry) => entry.destructive).map(commandItem));
      // Order: start and keep, then name and find, then copy and open, then the lifecycle.
      return lockWrites([
        {
          items: [
            ...(branch ? [{ id: "new-on-branch", label: `New thread on ${branch}`, ...glyph(SquarePen) }] : []),
            {
              id: "fork",
              label: "Fork",
              ...glyph(GitFork),
              submenu: [{
                items: [
                  { id: "tree", label: "Thread tree…", ...glyph(ListTree), ...chord(lookup, "runtime.thread-tree") },
                  { id: "duplicate", label: "Duplicate thread", ...glyph(CopyPlus), ...chord(lookup, "runtime.duplicate-thread") },
                  ...command("handoff.continue-in"),
                  ...command("handoff.bring-back"),
                ],
              }],
            },
            current?.pinned ? { id: "unpin", label: "Unpin thread", ...glyph(PinOff), ...chord(lookup, "thread.pin") } : { id: "pin", label: "Pin thread", ...glyph(Pin), ...chord(lookup, "thread.pin") },
            ...(settled || snoozed ? [] : [{
              id: "move",
              label: "Move",
              ...glyph(ArrowUpDown),
              submenu: [{ items: [{ id: "move-up", label: "Up", ...glyph(ArrowUp), ...chord(lookup, "thread.move-up") }, { id: "move-down", label: "Down", ...glyph(ArrowDown), ...chord(lookup, "thread.move-down") }] }],
            }]),
            settled
              ? { id: "unsettle", label: "Un-settle thread", ...glyph(ArchiveRestore), ...chord(lookup, "thread.settle") }
              : { id: "settle", label: "Settle thread", ...glyph(Check), ...chord(lookup, "thread.settle") },
            ...snoozeItems,
          ],
        },
        {
          items: [
            { id: "rename", label: "Rename thread", ...glyph(Pencil), ...chord(lookup, "runtime.rename-thread"), ...(renameWhy ? { disabled: true, description: renameWhy } : {}) },
            ...(port.titles?.() ? [{ id: "regenerate-title", label: "Regenerate title", ...glyph(Sparkles), ...chord(lookup, "thread-titles.regenerate") }] : []),
            { id: "mark-unread", label: "Mark unread", ...glyph(MessageSquareDot), ...chord(lookup, "thread.mark-unread") },
            ...(workspace?.setRailProjectFilter ? [{ id: "filter-project", label: filtered ? "Show all projects" : `Filter by ${session.projectName}`, ...glyph(filtered ? FunnelX : Funnel) }] : []),
          ],
        },
        {
          items: [
            {
              id: "copy",
              label: "Copy",
              ...glyph(Copy),
              submenu: [{
                items: [
                  { id: "copy-path", label: "Path", ...glyph(Folder) },
                  ...(branch ? [{ id: "copy-branch", label: "Branch", ...glyph(GitBranch) }] : []),
                  { id: "copy-thread-id", label: "Thread ID", ...glyph(Hash) },
                  { id: "copy-chat", label: "Chat as Markdown", ...glyph(MessageSquareText), ...chord(lookup, "runtime.copy-chat") },
                ],
              }],
            },
            ...command("workspace.open-in-editor"),
            { id: "instructions", label: "Instructions & prompt…", ...glyph(ScrollText), ...chord(lookup, "runtime.instructions") },
            ...(workspace?.openProjectSettings ? [{ id: "project-settings", label: "Project settings…", ...glyph(Settings) }] : []),
          ],
        },
        ...(others.some((entry) => !entry.destructive) ? [{ items: others.filter((entry) => !entry.destructive).map(commandItem) }] : []),
        lifecycle,
      ]);
    },
    runMenu(session, itemId, actions) {
      store.actions = actions;
      const workspace = port.workspace?.();
      const copy = (value: string | undefined, what: string) => {
        if (!value) return;
        actions.copyText(value).then(() => actions.notify(`${what} copied.`), (error: unknown) => actions.notify(errorMessage(error)));
      };
      if (itemId === "pin" || itemId === "unpin") togglePin(session.id);
      else if (itemId === "settle" || itemId === "unsettle") toggleSettledById(session.id, actions);
      else if (itemId === "wake") wake(session.id);
      else if (itemId === "snooze:custom") store.openSnooze(session);
      else if (itemId === "move-up") step(session.id, -1);
      else if (itemId === "move-down") step(session.id, 1);
      else if (itemId === "archive") void archive(session, actions);
      else if (itemId === "delete") void remove(session, actions);
      else if (itemId === "new-on-branch") actions.newSession({ workspace: session.workspaceId ?? session.projectPath, pick: true });
      else if (itemId === "rename") store.openRename(session);
      else if (itemId === "regenerate-title") void regenerateTitle(session, actions);
      else if (itemId === "mark-unread") store.threadStore?.markUnread(session.id);
      else if (itemId === "filter-project") workspace?.setRailProjectFilter?.(workspace.getSnapshot().railProjectFilter === session.projectName ? undefined : session.projectName);
      else if (itemId === "copy-path") copy(session.projectDisplayPath ?? session.projectPath, "Path");
      else if (itemId === "copy-branch") copy(session.projectLabel, "Branch");
      else if (itemId === "copy-thread-id") copy(session.id, "Thread ID");
      else if (itemId === "project-settings") workspace?.openProjectSettings?.(session);
      else if (itemId === "tree") void onThread(session, actions, () => actions.openThreadTree("navigate"));
      else if (itemId === "duplicate") void onThread(session, actions, () => actions.duplicateThread());
      else if (itemId === "instructions") void onThread(session, actions, () => actions.openInstructions?.());
      else if (itemId === "copy-chat") void onThread(session, actions, () => actions.copyChat?.());
      else if (itemId.startsWith("command:")) void onThread(session, actions, () => actions.executeCommand?.(itemId.slice("command:".length)));
      else {
        const preset = snoozePresets(new Date(now())).find((entry) => entry.id === itemId);
        if (preset) snooze(session.id, preset.until, actions);
      }
    },
    // The selection menu: what fits every selected thread, with how many it touches.
    bulkMenu(sessions) {
      const count = sessions.length;
      const pinned = sessions.filter((session) => meta(session.id)?.pinned).length;
      const snoozable = sessions.every((session) => ["pinned", "active"].includes(sectionOf(meta(session.id), now())));
      const idle = sessions.filter((session) => !port.running(session.id)).length;
      return lockWrites([
        {
          items: [
            ...(pinned > 0 ? [{ id: "unpin", label: `Unpin (${pinned})`, ...glyph(PinOff) }] : []),
            { id: "settle", label: `Settle (${count})`, ...glyph(Check) },
            ...(snoozable ? [{ id: "snooze", label: `Snooze (${count})`, ...glyph(AlarmClock), submenu: snoozeSubmenu() }] : []),
            { id: "mark-unread", label: `Mark unread (${count})`, ...glyph(MessageSquareDot) },
          ],
        },
        {
          items: [
            { id: "archive", label: `Archive (${idle})`, ...glyph(Archive), disabled: idle === 0, ...(idle < count ? { description: "Running threads stay." } : {}) },
            { id: "delete", label: `Delete (${idle})`, ...glyph(Trash2), destructive: true, disabled: idle === 0 },
          ],
        },
      ]);
    },
    runBulkMenu(sessions, itemId, actions) {
      store.actions = actions;
      const at = now();
      if (itemId === "unpin") {
        const pinned = sessions.filter((session) => meta(session.id)?.pinned);
        void ask("unpin", pinned).then((confirmed) => {
          if (!confirmed) return;
          const when = now();
          void changeMany(pinned.filter((session) => meta(session.id)?.pinned).map((session) => ({ threadId: session.id, patch: pinPatch(store.getState(), session.id, false, when), kind: "pin" as const, action: "Unpinned" as const })));
        });
      } else if (itemId === "settle") {
        // The whole selection leaves the active list together; the move skips all of it.
        parkAndMove(sessions.map((session) => session.id), actions, () => changeMany(sessions.filter((session) => meta(session.id)?.settledAt === undefined).map((session) => ({ threadId: session.id, patch: settlePatch(at, "user"), kind: "settle" as const, action: "Settled" as const }))));
      } else if (itemId === "snooze:custom") {
        store.openSnooze(sessions);
      } else if (itemId === "mark-unread") {
        for (const session of sessions) store.threadStore?.markUnread(session.id);
      } else if (itemId === "archive" || itemId === "delete") {
        // One after another: each may move the reader off the thread on screen.
        const leaving = new Set(sessions.map((session) => session.id));
        const idle = sessions.filter((session) => !port.running(session.id));
        void (async () => {
          // One question for the whole selection.
          if (!await ask(itemId === "archive" ? "archive" : "delete", idle)) return;
          for (const session of idle) {
            if (port.running(session.id)) continue;
            // oxlint-disable-next-line no-await-in-loop
            await (itemId === "archive" ? archive(session, actions, true) : remove(session, actions, leaving, true));
          }
        })();
      } else {
        const preset = snoozePresets(new Date(at)).find((entry) => entry.id === itemId);
        if (preset) snoozeMany(sessions.map((session) => session.id), preset.until, actions);
      }
    },
    toggleSettled: (session) => toggleSettledById(session.id),
    dropLabel: (threadId, target) => dropLabel(sectionOf(meta(threadId), now()), target.sectionId),
    drop,
    Layer,
    togglePin,
    toggleSettledById,
    snooze,
    archive,
    unarchive,
    remove,
    restore,
  };
}

/** Menu items that only read or stay on this device; a Read-only device gets the others disabled, with the reason. */
const DEVICE_ITEMS = new Set(["new-on-branch", "mark-unread", "filter-project", "copy", "copy-path", "copy-branch", "copy-thread-id", "copy-chat", "project-settings", "fork", "tree", "instructions"]);

function lockWrites(sections: MenuSection[]): MenuSection[] {
  if (!hostIsReadOnly()) return sections;
  return sections.map((section) => ({
    ...section,
    items: section.items.map((item): MenuItem => {
      // Commands carry their own refusal.
      if (item.id.startsWith("command:")) return item;
      const { submenu, ...rest } = item;
      if (!DEVICE_ITEMS.has(item.id)) return { ...rest, disabled: true, description: READ_ONLY_REASON };
      return submenu ? { ...rest, submenu: lockWrites(submenu) } : item;
    }),
  }));
}

const QUESTION_TEXT: Record<RailQuestionAction, { verb: string; message(count: number): string; destructive?: boolean }> = {
  delete: { verb: "Delete", destructive: true, message: (count) => `${count === 1 ? "It goes" : "They go"} to the trash; Settings → Archived brings ${count === 1 ? "it" : "them"} back.` },
  archive: { verb: "Archive", message: (count) => `${count === 1 ? "It leaves" : "They leave"} the rail until new work brings ${count === 1 ? "it" : "them"} back; Settings → Archived lists ${count === 1 ? "it" : "them"}.` },
  unpin: { verb: "Unpin", message: (count) => `${count === 1 ? "It moves" : "They move"} back among the active threads.` },
};

/** The confirmation before a delete, an archive or an unpin, with a way to stop asking. */
function RailConfirmation({ question, onDone }: { question: RailQuestion; onDone(): void }) {
  const text = QUESTION_TEXT[question.action];
  const count = question.sessions.length;
  const title = count === 1 ? `${text.verb} “${question.sessions[0]!.title}”?` : `${text.verb} ${count} threads?`;
  const answer = (confirmed: boolean, dontAskAgain = false) => {
    question.answer(confirmed, dontAskAgain);
    onDone();
  };
  return (
    <ConfirmDialog
      title={title}
      message={text.message(count)}
      confirmLabel={text.verb}
      destructive={text.destructive ?? false}
      {...(question.action === "delete" ? { icon: <Trash2 size={12} aria-hidden="true" /> } : {})}
      dontAskAgain
      onConfirm={(dontAskAgain) => answer(true, dontAskAgain)}
      onCancel={() => answer(false)}
    />
  );
}

type Unit = "minutes" | "hours" | "days";
const UNIT_MS: Record<Unit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** `YYYY-MM-DDTHH:mm` in local time, what a datetime-local field reads and writes. */
function localInput(epoch: number): string {
  const date = new Date(epoch);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A duration starts when the user confirms; a date is read in local time. */
export function SnoozeDialog({ sessions, now, onClose, onSnooze }: {
  sessions: readonly UiSession[];
  now: () => number;
  onClose(): void;
  onSnooze(until: number): void;
}) {
  const [mode, setMode] = useState<"duration" | "date">("duration");
  const [amount, setAmount] = useState("1");
  const [unit, setUnit] = useState<Unit>("hours");
  const [date, setDate] = useState(() => localInput(snoozePresets(new Date(now())).find((preset) => preset.id === "snooze:tomorrow")!.until));
  const until = mode === "duration" ? now() + Number(amount) * UNIT_MS[unit] : new Date(date).getTime();
  const valid = Number.isFinite(until) && until > now() && (mode === "date" || Number(amount) > 0);
  return (
    <Dialog className="confirm-dialog thread-rail-snooze" label="Snooze thread" onClose={onClose}>
      <h2>{sessions.length === 1 ? <>Snooze “{sessions[0]!.title}”</> : `Snooze ${sessions.length} threads`}</h2>
      <div className="segmented" role="group" aria-label="Snooze by">
        <button type="button" className={mode === "duration" ? "active" : ""} aria-pressed={mode === "duration"} onClick={() => setMode("duration")}>For a while</button>
        <button type="button" className={mode === "date" ? "active" : ""} aria-pressed={mode === "date"} onClick={() => setMode("date")}>Until a date</button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); if (valid) onSnooze(until); }}>
        {mode === "duration" ? (
          <div className="thread-rail-snooze-row">
            <input aria-label="How long" type="number" min="1" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus />
            <select aria-label="Unit" value={unit} onChange={(event) => setUnit(event.target.value as Unit)}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
        ) : (
          <div className="thread-rail-snooze-row">
            <input aria-label="Wake at" type="datetime-local" value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
        )}
        <footer>
          <button type="button" className="text-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!valid}>Snooze</button>
        </footer>
      </form>
    </Dialog>
  );
}

/** The row menu's Rename: the title as it is, selected, saved with Enter. */
export function RenameDialog({ session, onClose, onRename }: {
  session: UiSession;
  onClose(): void;
  onRename(title: string): Promise<boolean>;
}) {
  const [title, setTitle] = useState(session.title);
  const [saving, setSaving] = useState(false);
  const next = title.trim();
  return (
    <Dialog className="confirm-dialog thread-rail-snooze thread-rail-rename" label="Rename thread" onClose={onClose}>
      <h2>Rename thread</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!next || saving || next === session.title) { if (next === session.title) onClose(); return; }
          setSaving(true);
          void onRename(next).finally(() => setSaving(false));
        }}
      >
        <div className="thread-rail-snooze-row">
          <input aria-label="Thread title" maxLength={120} value={title} disabled={saving} autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => setTitle(event.target.value)} />
        </div>
        <footer>
          <button type="button" className="text-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!next || saving}>Rename</button>
        </footer>
      </form>
    </Dialog>
  );
}
