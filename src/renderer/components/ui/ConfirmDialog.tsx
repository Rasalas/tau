import { useState, type ReactNode } from "react";
import { Dialog } from "./Dialog";

/**
 * A yes-or-no question over the window, after T3 Code's: the title asks, the
 * message says what follows, Cancel and the action sit at the bottom right.
 * The action has focus, so Enter answers it and Escape cancels. With
 * `dontAskAgain` a box under the message lets the user turn the question off;
 * `onConfirm` hears whether it was ticked.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  dontAskAgain = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  dontAskAgain?: boolean;
  onConfirm(dontAskAgain: boolean): void;
  onCancel(): void;
}) {
  const [skip, setSkip] = useState(false);
  return (
    <Dialog className="confirm-dialog" label={title} onClose={onCancel}>
      <h2>{title}</h2>
      {message ? <p>{message}</p> : null}
      {dontAskAgain ? (
        <label className="confirm-dialog-skip">
          <input type="checkbox" checked={skip} onChange={(event) => setSkip(event.target.checked)} />
          Don’t ask again
        </label>
      ) : null}
      <footer>
        <button type="button" className="text-button" onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={destructive ? "danger" : "primary"} autoFocus onClick={() => onConfirm(skip)}>{confirmLabel}</button>
      </footer>
    </Dialog>
  );
}
