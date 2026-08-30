import { useEffect } from "react";
import { ShieldAlert } from "lucide-react";
import type { ToolApprovalRequest } from "../../shared/contracts";

export function ToolApproval({
  request,
  pending,
  onResolve,
}: {
  request: ToolApprovalRequest;
  /** How many further calls are waiting behind this one. */
  pending: number;
  onResolve(id: string, allowed: boolean): void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onResolve(request.id, false); }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onResolve(request.id, true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onResolve, request.id]);

  return (
    <div className="modal-scrim urgent">
      <section className="approval" role="dialog" aria-modal="true" aria-label="Approve tool call">
        <header>
          <span className="approval-mark"><ShieldAlert size={14} /></span>
          <strong>Approve {request.toolName}?</strong>
          {pending > 0 ? <small>{pending} more waiting</small> : null}
        </header>
        <pre>{request.summary}</pre>
        <footer>
          <span>access · ask before edits</span>
          <span className="spacer" />
          <button onClick={() => onResolve(request.id, false)}>Deny <kbd>esc</kbd></button>
          <button className="primary" autoFocus onClick={() => onResolve(request.id, true)}>
            Allow <kbd>⌘↵</kbd>
          </button>
        </footer>
      </section>
    </div>
  );
}
