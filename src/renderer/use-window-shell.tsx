import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { HostClient } from "../workbench/host-client";
import type { ThreadStore } from "../workbench/thread-store";
import type { ToastStore } from "../workbench/toast-store";
import type { QuitShortcutMode, ReleaseNotes, WindowAction, WindowShellEvent, WindowShellStatus } from "../shared/window-shell";
import type { PreferencesStore } from "./preferences";
import { ConfirmDialog, Dialog } from "./deferred-surfaces";
import { isMacPlatform } from "./keybindings";
import { armPasteAsText, disarmPasteAsText, isPasteAsTextChord } from "./paste-as-text";

/** A released hold's hint stays this long, so it is read rather than flashed. */
const HOLD_HINT_LINGER_MS = 1_200;

export interface WindowShellOptions {
  client?: HostClient;
  threadStore: ThreadStore;
  preferences: PreferencesStore;
  toasts: ToastStore;
  openSettings(page: string): void;
  openExternal(url: string): void;
  setUpdateReady(version: string): void;
}

/** What only the window's own process can start: the app menu, the quit, the notes after an update. */
export function useWindowShell(options: WindowShellOptions): { handle(event: WindowShellEvent): void; ui: ReactNode } {
  const latest = useRef(options);
  latest.current = options;
  const [quitHint, setQuitHint] = useState<QuitShortcutMode>();
  const [quitQuestion, setQuitQuestion] = useState<{ requestId: string; running: number }>();
  const [notes, setNotes] = useState<ReleaseNotes>();
  const hideHint = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hintMode = useRef<QuitShortcutMode>(undefined);

  const act = useCallback((action: WindowAction) => latest.current.client?.windowAction(action).catch(() => undefined), []);

  const handle = useCallback((event: WindowShellEvent) => {
    const { threadStore, preferences, openSettings } = latest.current;
    switch (event.kind) {
      case "menu":
        if (event.action === "open-settings") openSettings("defaults");
        else if (event.action === "open-about") openSettings("about");
        else {
          armPasteAsText();
          void act({ kind: "paste-as-text" });
        }
        return;
      case "quit-shortcut":
        clearTimeout(hideHint.current);
        if (event.state === "down") {
          hintMode.current = event.mode;
          setQuitHint(event.mode);
        } else if (hintMode.current === "hold") {
          hideHint.current = setTimeout(() => setQuitHint(undefined), HOLD_HINT_LINGER_MS);
        } else {
          // A second press that did not come has nothing left to ask for.
          setQuitHint(undefined);
        }
        return;
      case "quit-requested": {
        const running = threadStore.getSnapshot().runningThreadIds.length;
        if (running === 0 || !preferences.getSnapshot().confirmQuitWhileRunning) {
          void act({ kind: "answer-quit", requestId: event.requestId, answer: "quit" });
          return;
        }
        void act({ kind: "answer-quit", requestId: event.requestId, answer: "asking" });
        setQuitHint(undefined);
        setQuitQuestion({ requestId: event.requestId, running });
      }
    }
  }, [act]);

  // The chord arms Paste as Text before the paste arrives; leaving the window disarms it.
  useEffect(() => {
    const mac = isMacPlatform();
    const keydown = (event: KeyboardEvent) => { if (isPasteAsTextChord(event, mac)) armPasteAsText(); };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", disarmPasteAsText);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", disarmPasteAsText);
      clearTimeout(hideHint.current);
    };
  }, []);

  // A downloaded update and the notes of the version that just started, once per page.
  const client = options.client;
  useEffect(() => {
    if (!client) return;
    const announce = (release: ReleaseNotes) => {
      const readable = release.items.length > 0;
      latest.current.toasts.show({
        id: "tau.release-notes",
        type: "success",
        title: `Tau ${release.version} is installed`,
        ...(readable ? { description: "See what changed in this release." } : {}),
        timeoutMs: 0,
        actions: readable
          ? [{ label: "What’s new", run: () => setNotes(release) }]
          : release.url ? [{ label: "Release notes", run: () => latest.current.openExternal(release.url!) }] : [],
        onClose: () => { void client.windowAction({ kind: "release-notes-seen", version: release.version }).catch(() => undefined); },
      });
    };
    let live = true;
    void client.windowAction({ kind: "status" }).then((answer) => {
      const status = answer as WindowShellStatus | undefined;
      if (!live || !status) return;
      if (status.updateReady) latest.current.setUpdateReady(status.updateReady);
      if (status.releaseNotes) announce(status.releaseNotes);
    }, () => undefined);
    return () => { live = false; };
  }, [client]);

  const answerQuit = (quit: boolean, dontAskAgain = false) => {
    if (!quitQuestion) return;
    if (dontAskAgain) latest.current.preferences.setConfirmQuitWhileRunning(false);
    void act({ kind: "answer-quit", requestId: quitQuestion.requestId, answer: quit ? "quit" : "stay" });
    setQuitQuestion(undefined);
  };

  const shortcut = isMacPlatform() ? "⌘Q" : "Ctrl+Q";
  const ui = <>
    {quitHint ? (
      <div className="quit-hint" role="status">
        {quitHint === "hold" ? `Hold ${shortcut} or press it twice to quit` : `Press ${shortcut} again to quit`}
      </div>
    ) : null}
    {quitQuestion ? (
      <ConfirmDialog
        title="Quit Tau?"
        message={`${quitQuestion.running === 1 ? "A thread is" : `${quitQuestion.running} threads are`} still working. Quitting stops ${quitQuestion.running === 1 ? "it" : "them"}.`}
        confirmLabel="Quit"
        destructive
        dontAskAgain
        onConfirm={(dontAskAgain) => answerQuit(true, dontAskAgain)}
        onCancel={() => answerQuit(false)}
      />
    ) : null}
    {notes ? <ReleaseNotesDialog notes={notes} onOpen={(url) => latest.current.openExternal(url)} onClose={() => setNotes(undefined)} /> : null}
  </>;
  return { handle, ui };
}

/** The notes of the version that just started: what changed, and the rest on the release page. */
export function ReleaseNotesDialog({ notes, onOpen, onClose }: { notes: ReleaseNotes; onOpen(url: string): void; onClose(): void }) {
  const more = notes.totalItems - notes.items.length;
  return (
    <Dialog className="confirm-dialog release-notes" label={`What’s new in Tau ${notes.version}`} onClose={onClose}>
      <h2>What’s new in Tau {notes.version}</h2>
      <ul>{notes.items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
      <footer>
        {notes.url ? (
          <button type="button" className="text-button release-notes-link" onClick={() => onOpen(notes.url!)}>
            {more > 0 ? `${more} more ${more === 1 ? "change" : "changes"} on GitHub` : "View the release on GitHub"}
            <ExternalLink size={11} aria-hidden="true" />
          </button>
        ) : null}
        <button type="button" className="primary" autoFocus onClick={onClose}>Close</button>
      </footer>
    </Dialog>
  );
}
