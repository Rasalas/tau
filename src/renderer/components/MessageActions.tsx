import { useContext } from "react";
import { Copy, GitFork, Pencil } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import { WorkbenchShellContext } from "../workbench-context";
import { errorMessage } from "../../workbench/error-message";
import { PanelIcon } from "./PanelIcon";
import { tooltipProps } from "./ui/Tooltip";

/** The text selected inside this message's shell, if any. */
function selectionInside(element: Element | null): string | undefined {
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  return text && element && selection?.anchorNode && element.contains(selection.anchorNode) ? text : undefined;
}

function ExtensionMessageActions({ message }: { message: UiMessage }) {
  const shell = useContext(WorkbenchShellContext);
  const actions = shell?.actions;
  if (!actions) return null;
  return <>{shell.registry.getMessageActions()
    .filter((action) => (action.roles ?? ["assistant"]).includes(message.role as "user" | "assistant"))
    .map((action) => (
      <button
        key={action.id}
        type="button"
        tabIndex={-1}
        // Keeps the text selection the action reads.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          const selection = selectionInside(event.currentTarget.closest(".message-shell"));
          const run = async () => action.run(message, selection ? { selection } : {}, actions);
          run().catch((error) => actions.notify(errorMessage(error)));
        }}
      >
        <PanelIcon Icon={action.Icon} size={13} /><span>{action.label}</span>
      </button>
    ))}</>;
}

/**
 * A message's actions. They are no tab stops of their own: the transcript
 * reaches them through its focused message (→ in, ← or Escape out).
 */
export function MessageActions({ message, onCopy, onFork, onEdit }: { message?: UiMessage; onCopy(): void; onFork?: () => void; onEdit?: () => void }) {
  return <div className="message-actions" role="toolbar" aria-label="Message actions">
    <button type="button" tabIndex={-1} onClick={onCopy} {...tooltipProps("Copy message")}><Copy size={13} /><span>Copy</span></button>
    {onEdit ? <button type="button" tabIndex={-1} onClick={onEdit} {...tooltipProps("Rewind to before this message and edit it in the composer")}><Pencil size={13} /><span>Edit from here</span></button> : null}
    {onFork ? <button type="button" tabIndex={-1} onClick={onFork} {...tooltipProps("Fork through this message")}><GitFork size={13} /><span>Fork</span></button> : null}
    {message ? <ExtensionMessageActions message={message} /> : null}
  </div>;
}
