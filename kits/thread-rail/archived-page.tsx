import { useEffect, useState, useSyncExternalStore } from "react";
import { ArchiveRestore, RotateCcw } from "lucide-react";
import { Button, ConfirmDialog, Menu, SettingRow, SettingsSection, SettingsState, errorMessage, useThreadStore, type SettingsPageProps, type UiSession } from "tau";
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
 * Settings → Archived: archived threads by project, newest
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
    const [purging, setPurging] = useState<TrashedThread>();
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
      let live = true;
      setError(undefined);
      page.trash().then((list) => { if (live) setTrash(list); }, (reason: unknown) => { if (live) { setTrash([]); setError(errorMessage(reason)); } });
      const stop = page.subscribeTrash((list) => { setTrash(list); setError(undefined); });
      return () => { live = false; stop(); };
    }, [attempt]);

    const meta = store.getState().threads;
    const archived = threads
      .filter((thread) => meta[thread.id]?.archivedAt !== undefined && !thread.parentThreadId)
      .sort((left, right) => (meta[right.id]?.archivedAt ?? 0) - (meta[left.id]?.archivedAt ?? 0));
    const groups = new Map<string, UiSession[]>();
    for (const thread of archived) groups.set(thread.projectName, [...groups.get(thread.projectName) ?? [], thread]);
    const run = (work: Promise<void>, failure: string) => { work.catch((reason: unknown) => onNotify(`${failure}: ${errorMessage(reason)}`)); };

    return (
      <div className="settings-page thread-rail-archived">
        <h3>Archived</h3>
        {groups.size === 0 ? (
          <SettingsSection title="Archived threads" plain>
            <SettingsState kind="empty" title="No archived threads" description="Archive a thread from its menu in the rail to put it away without deleting it. It waits here until you unarchive it." />
          </SettingsSection>
        ) : [...groups].map(([project, sessions]) => (
          <SettingsSection key={project} title={project}>
            {sessions.map((session) => {
              const title = session.title || "Untitled thread";
              return (
                <div
                  key={session.id}
                  className="thread-rail-archived-row"
                  onContextMenu={(event) => { event.preventDefault(); setMenu({ session, x: event.clientX, y: event.clientY }); }}
                >
                  <SettingRow
                    title={title}
                    description={`Archived ${relativeTime(meta[session.id]?.archivedAt ?? now(), now())} · Last active ${relativeTime(session.modifiedAt, now())}`}
                    control={<Button icon={<ArchiveRestore size={13} aria-hidden="true" />} aria-label={`Unarchive ${title}`} onClick={() => page.unarchive(session.id)}>Unarchive</Button>}
                  />
                </div>
              );
            })}
          </SettingsSection>
        ))}

        {error ? (
          <SettingsSection title="Recently deleted" plain>
            <SettingsState kind="error" title="The deleted threads did not load" description={error} onRetry={() => setAttempt((count) => count + 1)} />
          </SettingsSection>
        ) : trash && trash.length > 0 ? (
          <SettingsSection title="Recently deleted">
            {trash.map((entry) => {
              const title = entry.title || "Untitled thread";
              return (
                <SettingRow
                  key={entry.sessionId}
                  title={title}
                  description={`Deleted ${relativeTime(entry.deletedAt, now())} · removed for good ${relativeTime(entry.purgeAt, now())}`}
                  control={<>
                    <Button icon={<RotateCcw size={13} aria-hidden="true" />} aria-label={`Restore ${title}`} onClick={() => run(page.restore(entry.sessionId), "Failed to restore thread")}>Restore</Button>
                    <Button variant="ghost" aria-label={`Delete ${title} now`} onClick={() => setPurging(entry)}>Delete now</Button>
                  </>}
                />
              );
            })}
          </SettingsSection>
        ) : null}
        {purging ? (
          <ConfirmDialog
            title={`Delete “${purging.title || "Untitled thread"}” for good?`}
            message="Its conversation is removed now rather than when its time in the trash runs out. It cannot be restored."
            confirmLabel="Delete for good"
            destructive
            onCancel={() => setPurging(undefined)}
            onConfirm={() => { const entry = purging; setPurging(undefined); run(page.purge(entry.sessionId), "Failed to delete thread"); }}
          />
        ) : null}

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
