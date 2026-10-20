import type { QuitShortcutMode, ReleaseNotes } from "../../shared/window-shell";
import { Dialog } from "./ui/Dialog";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { isMacPlatform } from "../keybindings";
import { ReleaseNotesContent } from "./UpdateNotes";

/** The notes of the version that just started: what changed, and the rest on the release page. */
export function ReleaseNotesDialog({ notes, onOpen, onClose }: { notes: ReleaseNotes; onOpen(url: string): void; onClose(): void }) {
  return <Dialog className="confirm-dialog release-notes update-center" label={`What’s new in Tau ${notes.version}`} onClose={onClose}>
    <h2>What’s new in Tau {notes.version}</h2>
    <ReleaseNotesContent version={notes.version} notes={{ state: "ready", releases: [notes] }} onRetry={() => {}} onOpen={onOpen} />
    <footer><button type="button" className="primary" autoFocus onClick={onClose}>Close</button></footer>
  </Dialog>;
}

/** Window-level hints and dialogs load when they first have something to show. */
export function WindowShellUi({ quitHint, running, notes, onAnswerQuit, onOpen, onCloseNotes }: {
  quitHint: QuitShortcutMode | undefined;
  running: number | undefined;
  notes: ReleaseNotes | undefined;
  onAnswerQuit(quit: boolean, dontAskAgain?: boolean): void;
  onOpen(url: string): void;
  onCloseNotes(): void;
}) {
  const shortcut = isMacPlatform() ? "⌘Q" : "Ctrl+Q";
  return <>
    {quitHint ? <div className="quit-hint" role="status">{quitHint === "hold" ? `Hold ${shortcut} or press it twice to quit` : `Press ${shortcut} again to quit`}</div> : null}
    {running !== undefined ? <ConfirmDialog
      title="Quit Tau?"
      message={`${running === 1 ? "A thread is" : `${running} threads are`} still working. Quitting stops ${running === 1 ? "it" : "them"}.`}
      confirmLabel="Quit"
      destructive
      dontAskAgain
      onConfirm={(dontAskAgain) => onAnswerQuit(true, dontAskAgain)}
      onCancel={() => onAnswerQuit(false)}
    /> : null}
    {notes ? <ReleaseNotesDialog notes={notes} onOpen={onOpen} onClose={onCloseNotes} /> : null}
  </>;
}
