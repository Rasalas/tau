import { useContext } from "react";
import { Copy, GitFork } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import { WorkbenchShellContext } from "../workbench-context";
import { errorMessage } from "../../workbench/error-message";
import { PanelIcon } from "./PanelIcon";

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
        title={action.label}
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

export function MessageActions({ message, onCopy, onFork }: { message?: UiMessage; onCopy(): void; onFork?: () => void }) {
  return <div className="message-actions">
    <button type="button" onClick={onCopy} title="Copy message"><Copy size={13} /><span>Copy</span></button>
    {onFork ? <button type="button" onClick={onFork} title="Fork through this message"><GitFork size={13} /><span>Fork</span></button> : null}
    {message ? <ExtensionMessageActions message={message} /> : null}
  </div>;
}
