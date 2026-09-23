import { useEffect, useState, useSyncExternalStore } from "react";
import { Archive, ArchiveRestore, RotateCcw } from "lucide-react";
import { Menu, SettingRow, SettingsSection, errorMessage, useThreadStore, type SettingsPageProps, type UiSession } from "tau";
import type { TrashedThread } from "./protocol.js";
import type { RailStore } from "./store.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "in 30 days": a distance from now, roughly. */
export function relativeTime(at: number, now: number): string {
  const distance = Math.abs(now - at);
  const [amount, unit] = distance < MINUTE ? [0, ""]
    : distance < HOUR ? [Math.round(distance / MINUTE), "minute"]
      : distance < DAY ? [Math.round(distance / HOUR), "hour"]
        : [Math.round(distance / DAY), "day"];
  if (amount === 0) return "just now";
  const span = `${amount} ${unit}${amount === 1 ? "" : "s"}`;
  return at > now ? `in ${span}` : `${span} ago`;
}

export interface ArchivedPageActions {
  unarchive(threadId: string): void;
  remove(session: UiSession): Promise<void>;
  restore(threadId: string): Promise<void>;
  purge(threadId: string): Promise<void>;
  /** The trash as the host has it now; `subscribe` hears every change. */
  trash(): Promise<readonly TrashedThread[]>;
  subscribeTrash(listener: (trash: readonly TrashedThread[]) => void): () => void;
}

/**
 * Settings → Archived, after T3 Code's: archived threads by project, newest
 * first, with Unarchive on the row and Delete in its context menu. Tau adds
 * the threads deleted in the last days, which can still be restored.
 */
export function createArchivedPage(store: RailStore, page: ArchivedPageActions, now: () => number = Date.now) {
  return function ArchivedThreads({ onNotify }: SettingsPageProps) {
    useSyncExternalStore(store.subscribe, store.getVersion);
    const threadStore = useThreadStore();
    const { threads } = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
    const [trash, setTrash] = useState<readonly TrashedThread[] | undefined>();
    const [error, setError] = useState<string>();
    const [menu, setMenu] = useState<{ session: UiSession; x: number; y: number }>();
    const [confirming, setConfirming] = useState<string>();

    useEffect(() => {
      let live = true;
      page.trash().then((list) => { if (live) setTrash(list); }, (reason: unknown) => { if (live) { setTrash([]); setError(errorMessage(reason)); } });
      const stop = page.subscribeTrash((list) => setTrash(list));
      return () => { live = false; stop(); };
    }, []);

    const meta = store.getState().threads;
    const archived = threads
      .filter((thread) => meta[thread.id]?.archivedAt !== undefined && !thread.parentThreadId)
      .sort((left, right) => (meta[right.id]?.archivedAt ?? 0) - (meta[left.id]?.archivedAt ?? 0));
    const groups = new Map<string, UiSession[]>();
    for (const thread of archived) groups.set(thread.projectName, [...groups.get(thread.projectName) ?? [], thread]);
    const run = (work: Promise<void>, failure: string) => { work.catch((reason: unknown) => onNotify(`${failure}: ${errorMessage(reason)}`)); };

    return (
      <div className="thread-rail-archived">
        {groups.size === 0 ? (
          <SettingsSection title="Archived threads">
            <SettingRow
              title={<span className="thread-rail-archived-empty"><Archive size={14} aria-hidden="true" />No archived threads</span>}
              description="Archived threads will appear here."
            />
          </SettingsSection>
        ) : [...groups].map(([project, sessions]) => (
          <SettingsSection key={project} title={project}>
            {sessions.map((session) => (
              <div
                key={session.id}
                className="thread-rail-archived-row"
                onContextMenu={(event) => { event.preventDefault(); setMenu({ session, x: event.clientX, y: event.clientY }); }}
              >
                <SettingRow
                  title={session.title || "Untitled thread"}
                  description={`Archived ${relativeTime(meta[session.id]?.archivedAt ?? now(), now())} · Last active ${relativeTime(session.modifiedAt, now())}`}
                  control={(
                    <button type="button" className="chrome-button" onClick={() => page.unarchive(session.id)}>
                      <ArchiveRestore size={13} aria-hidden="true" />Unarchive
                    </button>
                  )}
                />
              </div>
            ))}
          </SettingsSection>
        ))}

        {trash && trash.length > 0 ? (
          <SettingsSection title="Recently deleted">
            {trash.map((entry) => (
              <SettingRow
                key={entry.sessionId}
                title={entry.title || "Untitled thread"}
                description={`Deleted ${relativeTime(entry.deletedAt, now())} · removed for good ${relativeTime(entry.purgeAt, now())}`}
                control={(
                  <span className="thread-rail-archived-actions">
                    <button type="button" className="chrome-button" onClick={() => run(page.restore(entry.sessionId), "Failed to restore thread")}>
                      <RotateCcw size={13} aria-hidden="true" />Restore
                    </button>
                    <button
                      type="button"
                      className="chrome-button danger"
                      onClick={() => {
                        // A second click, because this one cannot be undone.
                        if (confirming !== entry.sessionId) { setConfirming(entry.sessionId); return; }
                        setConfirming(undefined);
                        run(page.purge(entry.sessionId), "Failed to delete thread");
                      }}
                      onBlur={() => setConfirming((current) => current === entry.sessionId ? undefined : current)}
                    >
                      {confirming === entry.sessionId ? "Delete for good" : "Delete now"}
                    </button>
                  </span>
                )}
              />
            ))}
          </SettingsSection>
        ) : null}
        {error ? <p className="settings-note">{error}</p> : null}

        {menu ? (
          <div className="thread-rail-menu-anchor" style={{ left: menu.x, top: menu.y }}>
            <Menu
              align="left"
              sections={[{ items: [{ id: "unarchive", label: "Unarchive" }, { id: "delete", label: "Delete", destructive: true }] }]}
              onSelect={(id) => {
                if (id === "unarchive") page.unarchive(menu.session.id);
                else run(page.remove(menu.session), "Failed to delete thread");
              }}
              onClose={() => setMenu(undefined)}
            />
          </div>
        ) : null}
      </div>
    );
  };
}
