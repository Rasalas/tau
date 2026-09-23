import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog, errorMessage, useThreadStore, useWorkbenchShell, type MenuSection, type ToastHandle, type UiSession, type WorkbenchActions } from "tau";
import {
  UNARCHIVE_PATCH,
  WAKE_PATCH,
  dropLabel,
  dropPatches,
  fallbackThread,
  inversePatch,
  pinPatch,
  railSections,
  sectionOf,
  settlePatch,
  snoozePatch,
  snoozePresets,
  unsettlePatch,
  type RailDrop,
} from "./meta.js";
import type { RailOrganizer, RailSections, ThreadMetaPatch } from "./protocol.js";
import type { RailStore } from "./store.js";
import type { ThreadUndo, UndoAction, UndoKind } from "./undo.js";

export type SendPatches = (patches: Record<string, ThreadMetaPatch | null>) => void;

/** What the organizer asks of the rest of the kit: the host half and the undo list. */
export interface RailOrganizerPort {
  send: SendPatches;
  undo: ThreadUndo;
  /** The host refuses a running thread. */
  archive(threadId: string): Promise<void>;
  remove(threadId: string): Promise<void>;
  restore(threadId: string): Promise<void>;
  running(threadId: string): boolean;
}

const EMPTY: RailSections = { pinned: [], active: [], snoozed: [], settled: [], archived: [] };

/** The thread on screen, when it is this one and not a pending draft. */
const onScreen = (actions: WorkbenchActions | undefined, threadId: string): boolean => {
  const active = actions?.activeThread();
  return Boolean(active && !active.draftPending && active.sessionId === threadId);
};

/** The rail as Thread Rail sees it: four sections, the row menu, drops, the snooze dialog and the undo notice. */
export function createRailOrganizer(store: RailStore, port: RailOrganizerPort, now: () => number = Date.now): RailOrganizer & {
  /** Pin or unpin, settle or un-settle, by thread id; the commands' way in. */
  togglePin(threadId: string): void;
  toggleSettledById(threadId: string): void;
  snooze(threadId: string, until: number): void;
  archive(session: UiSession, actions: WorkbenchActions | undefined): Promise<void>;
  unarchive(threadId: string): void;
  remove(session: UiSession, actions: WorkbenchActions | undefined): Promise<void>;
  restore(threadId: string): Promise<void>;
} {
  const { send, undo } = port;
  let last: RailSections = EMPTY;
  const meta = (threadId: string) => store.getState().threads[threadId];

  /** Sends the patches and, for an action the notice offers back, what takes them back. */
  const change = (patches: Record<string, ThreadMetaPatch>, record?: { threadId: string; kind: UndoKind; action: UndoAction }) => {
    const inverse = Object.fromEntries(Object.entries(patches).map(([id, patch]) => [id, inversePatch(meta(id), patch)]));
    send(patches);
    if (record) undo.record(record.kind, record.threadId, record.action, async () => send(inverse));
  };

  const togglePin = (threadId: string) => {
    const pinned = Boolean(meta(threadId)?.pinned);
    if (!pinned) undo.invalidate("pin", threadId);
    change({ [threadId]: pinPatch(store.getState(), threadId, !pinned, now()) }, pinned ? { threadId, kind: "pin", action: "Unpinned" } : undefined);
  };
  const toggleSettledById = (threadId: string) => {
    if (meta(threadId)?.settledAt !== undefined) {
      undo.invalidate("settle", threadId);
      change({ [threadId]: unsettlePatch(now()) });
    } else {
      change({ [threadId]: settlePatch(now(), "user") }, { threadId, kind: "settle", action: "Settled" });
    }
  };
  const snooze = (threadId: string, until: number) => change({ [threadId]: snoozePatch(until) }, { threadId, kind: "snooze", action: "Snoozed" });
  const wake = (threadId: string) => {
    undo.invalidate("snooze", threadId);
    change({ [threadId]: WAKE_PATCH });
  };
  const drop = (threadId: string, target: RailDrop) => {
    const label = dropLabel(sectionOf(meta(threadId), now()), target.sectionId);
    const patches = dropPatches(store.getState(), last, threadId, target, now());
    if (!patches) return;
    const record = label === "Settle" ? { threadId, kind: "settle" as const, action: "Settled" as const }
      : label === "Unpin" ? { threadId, kind: "pin" as const, action: "Unpinned" as const } : undefined;
    change(patches, record);
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

  /** As in T3 Code: a running thread cannot be archived, and archiving the thread on screen opens a new one in its project. */
  const archive = async (session: UiSession, actions: WorkbenchActions | undefined) => {
    if (port.running(session.id)) { notify(actions, "Cannot archive a running thread."); return; }
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
    change({ [threadId]: UNARCHIVE_PATCH });
  };

  /** Into the host's trash; the notice, `mod+z` and Settings → Archived bring it back. */
  const remove = async (session: UiSession, actions: WorkbenchActions | undefined) => {
    if (port.running(session.id)) { notify(actions, "Stop the thread before deleting it."); return; }
    const shown = onScreen(actions, session.id);
    if (shown) {
      const next = fallbackThread(store.displayed, session);
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
    const shortcut = registry.keybindingLabel("thread.undo");
    const text = notice ? `${notice.action} ${notice.count} thread${notice.count === 1 ? "" : "s"}` : undefined;
    const toast = actions.toast;
    useEffect(() => {
      if (!toast) return;
      if (!text) { undoToast?.dismiss(); undoToast = undefined; return; }
      // The undo's own window decides when it goes, so the toast has no clock of its own.
      undoToast = toast({
        id: "tau.thread-rail.undo",
        type: "success",
        title: text,
        ...(shortcut ? { description: `${shortcut} to undo` } : {}),
        timeoutMs: 0,
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
    const session = store.snoozeDialogFor;
    return (
      <>
        <UndoNotice actions={actions} />
        {session ? (
          <SnoozeDialog
            key={session.id}
            session={session}
            now={now}
            onClose={() => store.openSnooze(undefined)}
            onSnooze={(until) => { snooze(session.id, until); store.openSnooze(undefined); }}
          />
        ) : null}
      </>
    );
  }

  const lifecycleSection = (session: UiSession): MenuSection => {
    const running = port.running(session.id);
    return {
      items: [
        { id: "archive", label: "Archive thread", disabled: running, ...(running ? { description: "Cannot archive a running thread." } : {}) },
        { id: "delete", label: "Delete", destructive: true, disabled: running, ...(running ? { description: "Stop the thread before deleting it." } : {}) },
      ],
    };
  };

  return {
    subscribe: store.subscribe,
    getVersion: store.getVersion,
    sections(threads) {
      last = railSections(threads, store.getState(), now());
      store.displayed = [...last.pinned, ...last.active];
      return [
        { id: "pinned", label: "Pinned", threads: last.pinned },
        { id: "active", threads: last.active },
        { id: "snoozed", label: "Snoozed", shelf: true, collapsed: true, threads: last.snoozed },
        { id: "settled", label: "Settled", shelf: true, settled: true, threads: last.settled },
      ];
    },
    menu(session) {
      const current = meta(session.id);
      const section = sectionOf(current, now());
      if (section === "settled") {
        return [{ items: [{ id: "unsettle", label: "Un-settle thread" }, { id: "pin", label: "Pin thread" }] }, lifecycleSection(session)];
      }
      const snoozed = section === "snoozed";
      return [
        { items: [current?.pinned ? { id: "unpin", label: "Unpin thread" } : { id: "pin", label: "Pin thread" }] },
        {
          items: snoozed
            ? [{ id: "wake", label: "Wake thread" }, { id: "snooze:custom", label: "Snooze until…" }]
            : [{
              id: "snooze",
              label: "Snooze",
              submenu: [{ items: [...snoozePresets(new Date(now())).map(({ id, label }) => ({ id, label })), { id: "snooze:custom", label: "Custom…" }] }],
            }],
        },
        {
          items: [
            { id: "settle", label: "Settle thread" },
            ...(snoozed ? [] : [{ id: "move-up", label: "Move up" }, { id: "move-down", label: "Move down" }]),
          ],
        },
        lifecycleSection(session),
      ];
    },
    runMenu(session, itemId, actions) {
      store.actions = actions;
      if (itemId === "pin" || itemId === "unpin") togglePin(session.id);
      else if (itemId === "settle" || itemId === "unsettle") toggleSettledById(session.id);
      else if (itemId === "wake") wake(session.id);
      else if (itemId === "snooze:custom") store.openSnooze(session);
      else if (itemId === "move-up") step(session.id, -1);
      else if (itemId === "move-down") step(session.id, 1);
      else if (itemId === "archive") void archive(session, actions);
      else if (itemId === "delete") void remove(session, actions);
      else {
        const preset = snoozePresets(new Date(now())).find((entry) => entry.id === itemId);
        if (preset) snooze(session.id, preset.until);
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

type Unit = "minutes" | "hours" | "days";
const UNIT_MS: Record<Unit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** `YYYY-MM-DDTHH:mm` in local time, what a datetime-local field reads and writes. */
function localInput(epoch: number): string {
  const date = new Date(epoch);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A duration starts when the user confirms; a date is read in local time. */
export function SnoozeDialog({ session, now, onClose, onSnooze }: {
  session: UiSession;
  now: () => number;
  onClose(): void;
  onSnooze(until: number): void;
}) {
  const [mode, setMode] = useState<"duration" | "date">("duration");
  const [amount, setAmount] = useState("1");
  const [unit, setUnit] = useState<Unit>("hours");
  const [date, setDate] = useState(() => localInput(snoozePresets(new Date(now()))[1]!.until));
  const until = mode === "duration" ? now() + Number(amount) * UNIT_MS[unit] : new Date(date).getTime();
  const valid = Number.isFinite(until) && until > now() && (mode === "date" || Number(amount) > 0);
  return (
    <Dialog className="thread-rail-snooze" label="Snooze thread" onClose={onClose}>
      <h2>Snooze “{session.title}”</h2>
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
