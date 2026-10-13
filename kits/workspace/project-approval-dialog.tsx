import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, errorMessage, type RegionProps } from "tau";
import { PROJECT_APPROVAL_EVENT, type ProjectApprovalRequest } from "../_project-file/setup-approval.js";

interface ApprovalHost {
  invoke(command: string, input?: unknown): Promise<unknown>;
  onEvent(name: string, listener: (payload: unknown) => void): () => void;
}

export function createProjectApprovalDialog(host: ApprovalHost) {
  return function ProjectApprovalDialog({ actions }: RegionProps) {
    const [requests, setRequests] = useState<ProjectApprovalRequest[]>([]);
    const [answering, setAnswering] = useState<string>();
    useEffect(() => {
      let live = true;
      let pushed = false;
      const off = host.onEvent(PROJECT_APPROVAL_EVENT, (payload) => {
        pushed = true;
        if (Array.isArray(payload)) setRequests(payload as ProjectApprovalRequest[]);
      });
      void host.invoke("project-approvals").then((payload) => {
        if (live && !pushed && Array.isArray(payload)) setRequests(payload as ProjectApprovalRequest[]);
      }, () => undefined);
      return () => { live = false; off(); };
    }, []);
    const request = requests[0];
    if (!request) return null;
    const busy = answering === request.id;
    const answer = async (approved: boolean) => {
      if (busy) return;
      setAnswering(request.id);
      try { await host.invoke("answer-project-approval", { id: request.id, approved }); }
      catch (error) { actions.notify(errorMessage(error)); }
      finally { setAnswering(undefined); }
    };
    return createPortal(
      <Dialog label="Allow project setup commands?" className="confirm-dialog" onClose={() => { void answer(false); }}>
        <h2>Allow project setup commands?</h2>
        <p><code>{request.project}/.tau/project.json</code></p>
        <p>These commands run on the host with your environment in each new worktree. Approve only commands you trust. Changes to the script definitions require approval again.</p>
        <pre className="project-approval-commands">{request.commands.join("\n\n")}</pre>
        <footer>
          <button type="button" className="text-button" disabled={busy} onClick={() => { void answer(false); }}>Skip setup</button>
          <button type="button" className="primary" disabled={busy} onClick={() => { void answer(true); }}>Allow project setup</button>
        </footer>
      </Dialog>, document.body,
    );
  };
}
