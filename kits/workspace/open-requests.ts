import { errorMessage, type WorkbenchActions } from "tau";
import type { OpenRequest } from "./storage-protocol.js";

export const isOpenRequest = (value: unknown): value is OpenRequest =>
  Boolean(value && typeof (value as OpenRequest).workspaceId === "string" && typeof (value as OpenRequest).displayPath === "string");

/**
 * `tau app <path>` on the window's side: the project opens and a new thread's
 * draft waits in it — a project the window did not know yet opens on its own
 * empty thread. A request that arrives before the workbench bound its actions
 * waits for them.
 */
export class OpenRequests {
  private actions: WorkbenchActions | undefined;
  private pending: OpenRequest | undefined;

  bind(actions: WorkbenchActions): void {
    this.actions = actions;
    this.flush();
  }

  receive(request: unknown): void {
    if (!isOpenRequest(request)) return;
    this.pending = request;
    this.flush();
  }

  private flush(): void {
    const actions = this.actions;
    const request = this.pending;
    if (!actions || !request) return;
    this.pending = undefined;
    void (async () => {
      try {
        if (!await actions.openWorkspace(request.workspaceId)) return;
        actions.newSession({ workspace: request.workspaceId });
        actions.focusComposer();
      } catch (error) {
        actions.notify(`Could not open ${request.displayPath}: ${errorMessage(error)}`);
      }
    })();
  }
}
