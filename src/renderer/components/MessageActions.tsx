import { lazy, Suspense, useContext, useRef } from "react";
import { createPortal } from "react-dom";
import { Copy, GitFork, Pencil } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import { WorkbenchShellContext } from "../workbench-context";
import { errorMessage } from "../../workbench/error-message";
import { useMessageMenu } from "../touch/use-message-menu";
import type { SheetAction } from "../touch/ActionSheet";
import { PanelIcon } from "./PanelIcon";
import { tooltipProps } from "./ui/Tooltip";

const LazyActionSheet = lazy(() => import("../touch/ActionSheet").then(({ ActionSheet }) => ({ default: ActionSheet })));

/** The text selected inside this message's shell, if any. */
function selectionInside(element: Element | null): string | undefined {
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  return text && element && selection?.anchorNode && element.contains(selection.anchorNode) ? text : undefined;
}

/** The desktop toolbar and mobile long-press sheet share the message's actions. */
export function MessageActions({ message, onCopy, onFork, onEdit }: { message?: UiMessage; onCopy(): void; onFork?: () => void; onEdit?: () => void }) {
  const toolbar = useRef<HTMLDivElement>(null);
  const menu = useMessageMenu(toolbar);
  const shell = useContext(WorkbenchShellContext);
  const actions: (SheetAction & { hint?: string })[] = [
    { id: "copy", label: "Copy", hint: "Copy message", Icon: Copy, run: onCopy },
    ...(onEdit ? [{ id: "edit", label: "Edit from here", hint: "Rewind to before this message and edit it in the composer", Icon: Pencil, run: onEdit }] : []),
    ...(onFork ? [{ id: "fork", label: "Fork", hint: "Fork through this message", Icon: GitFork, run: onFork }] : []),
  ];
  if (message && shell?.actions) {
    const workbench = shell.actions;
    for (const action of shell.registry.getMessageActions().filter((candidate) => (candidate.roles ?? ["assistant"]).includes(message.role as "user" | "assistant"))) {
      actions.push({
        id: `extension:${action.id}`, label: action.label, Icon: action.Icon,
        run: () => {
          const selection = selectionInside(toolbar.current?.closest(".message-shell") ?? null);
          const run = async () => action.run(message, selection ? { selection } : {}, workbench);
          void run().catch((error) => workbench.notify(errorMessage(error)));
        },
      });
    }
  }
  return <>
    <div ref={toolbar} className="message-actions" role="toolbar" aria-label="Message actions">
      {actions.map((action) => <button key={action.id} type="button" tabIndex={-1}
        onMouseDown={action.id.startsWith("extension:") ? (event) => event.preventDefault() : undefined}
        onClick={action.run} {...(action.hint ? tooltipProps(action.hint) : {})}>
        <PanelIcon Icon={action.Icon} size={13} /><span>{action.label}</span>
      </button>)}
    </div>
    {menu.open ? createPortal(<Suspense fallback={null}><LazyActionSheet title="Message actions" actions={actions} onClose={menu.close} /></Suspense>, document.body) : null}
  </>;
}
