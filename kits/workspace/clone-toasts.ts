import { errorMessage, type ToastHandle, type ToastOptions, type WorkbenchActions } from "tau";
import type { CloneSnapshot, CloneStage, WorkspaceHostClient } from "./protocol.js";

const STAGE_LABELS: Record<CloneStage, string> = {
  connecting: "Connecting",
  counting: "Counting objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  checkout: "Checking out files",
};

/** `Receiving objects · 45% · 12.3 MiB | 5.0 MiB/s`. */
export function cloneProgressSummary(snapshot: Pick<CloneSnapshot, "stage" | "percent" | "detail">): string {
  return [STAGE_LABELS[snapshot.stage], snapshot.percent === undefined ? undefined : `${snapshot.percent}%`, snapshot.detail].filter(Boolean).join(" · ");
}

export const isCloneSnapshot = (value: unknown): value is CloneSnapshot =>
  Boolean(value && typeof (value as CloneSnapshot).id === "string" && typeof (value as CloneSnapshot).phase === "string");

/**
 * One toast per clone: it updates in
 * place while git reports stages, offers Cancel while it runs and Open project
 * once it is done. The project source that started the clone has closed by then.
 */
export class CloneToasts {
  private actions: WorkbenchActions | undefined;
  private readonly latest = new Map<string, CloneSnapshot>();
  private readonly shown = new Map<string, { handle: ToastHandle; key: string }>();

  constructor(private readonly host: Pick<WorkspaceHostClient, "cancelClone" | "forgetClone">) {}

  bind(actions: WorkbenchActions): void {
    this.actions = actions;
    for (const snapshot of this.latest.values()) this.render(snapshot);
  }

  receive(value: unknown): void {
    if (!isCloneSnapshot(value)) return;
    this.latest.set(value.id, value);
    this.render(value);
  }

  private render(snapshot: CloneSnapshot): void {
    const actions = this.actions;
    if (!actions) return;
    const key = `${snapshot.phase}:${snapshot.stage}:${snapshot.percent ?? ""}:${snapshot.detail ?? ""}`;
    const current = this.shown.get(snapshot.id);
    if (current?.key === key) return;
    const options = this.options(snapshot, actions);
    if (!actions.toast) {
      if (snapshot.phase !== "running") actions.notify([options.title, options.description].filter(Boolean).join(" · "));
      if (snapshot.phase !== "running") this.settle(snapshot.id);
      return;
    }
    // Progress updates in place; the end replaces the toast so its own clock starts.
    if (current && snapshot.phase === "running") {
      current.handle.update(options);
      this.shown.set(snapshot.id, { handle: current.handle, key });
      return;
    }
    this.shown.set(snapshot.id, { handle: actions.toast({ ...options, id: `workspace.clone.${snapshot.id}` }), key });
  }

  private options(snapshot: CloneSnapshot, actions: WorkbenchActions): Omit<ToastOptions, "id"> {
    const forget = () => this.settle(snapshot.id);
    switch (snapshot.phase) {
      case "running":
        return {
          type: "loading",
          title: `Cloning ${snapshot.name}`,
          description: cloneProgressSummary(snapshot),
          timeoutMs: 0,
          actions: [{ label: "Cancel", keepOpen: true, run: () => void this.host.cancelClone(snapshot.id).catch((error: unknown) => actions.notify(errorMessage(error))) }],
        };
      case "done": {
        const workspace = snapshot.workspace;
        return {
          type: "success",
          title: `Cloned ${snapshot.name}`,
          description: snapshot.destination,
          // It stays until opened or dismissed: the project is not in the list before it is opened.
          timeoutMs: 0,
          onClose: forget,
          actions: workspace ? [{
            label: "Open project",
            run: () => void actions.openWorkspace(workspace.workspaceId).catch((error: unknown) => actions.notify(errorMessage(error))),
          }] : [],
        };
      }
      case "cancelled":
        return {
          type: "info",
          title: `Cancelled cloning ${snapshot.name}`,
          description: snapshot.leftover ? `${snapshot.leftover} held other files and was left in place.` : "The partial clone was removed.",
          onClose: forget,
        };
      case "failed":
        return {
          type: "error",
          title: `Could not clone ${snapshot.name}`,
          description: snapshot.error ?? "git clone failed.",
          ...(snapshot.error ? { copyText: snapshot.error } : {}),
          onClose: forget,
        };
    }
  }

  private settle(id: string): void {
    this.latest.delete(id);
    this.shown.delete(id);
    void this.host.forgetClone(id).catch(() => undefined);
  }
}
