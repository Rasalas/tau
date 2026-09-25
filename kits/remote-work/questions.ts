import type { PlatformAttention, PlatformEnvironments, ToastHandle, WorkbenchActions } from "tau";
import type { RemoteThreadLink } from "./protocol.js";

export interface QuestionNoticePorts {
  actions(): WorkbenchActions | undefined;
  attention(): PlatformAttention | undefined;
  environments(): PlatformEnvironments | undefined;
  /** Whether someone looks at this window now; a system notification is only for when nobody does. */
  focused(): boolean;
}

/** What a link asks, while it waits there; undefined otherwise. */
export function linkQuestion(link: RemoteThreadLink): string | undefined {
  return link.status === "waiting" && link.thread ? link.there?.question ?? "" : undefined;
}

/**
 * Tells this window when a thread it runs on another machine starts to wait
 * on a question there: a toast with "Open on <machine>" and "Look in", and a
 * system notification when the window is not in front, whose click moves the
 * window there. Answering is that machine's; the toast goes once it moves on.
 * Only links seen changing count, so a page that loads while one waits (or
 * comes back from answering it) says nothing.
 */
export class QuestionNotices {
  private readonly asked = new Map<string, string>();
  private readonly toasts = new Map<string, ToastHandle>();

  constructor(private readonly ports: QuestionNoticePorts) {}

  /** The links as a page first reads them: remembered, not announced. */
  seed(links: readonly RemoteThreadLink[]): void {
    for (const link of links) {
      const question = linkQuestion(link);
      if (question !== undefined) this.asked.set(link.id, question);
    }
  }

  update(link: RemoteThreadLink): void {
    const question = linkQuestion(link);
    if (question === undefined) {
      this.asked.delete(link.id);
      this.toasts.get(link.id)?.dismiss();
      this.toasts.delete(link.id);
      return;
    }
    if (this.asked.get(link.id) === question) return;
    this.asked.set(link.id, question);
    this.announce(link, question);
  }

  /** Moves the window to the thread's machine with the thread open, where its question can be answered. */
  openThere(link: RemoteThreadLink): Promise<void> {
    const environments = this.ports.environments();
    if (!environments || !link.thread) return Promise.reject(new Error("This client cannot show another machine."));
    return environments.open(link.machine, { threadId: link.thread });
  }

  dispose(): void {
    for (const toast of this.toasts.values()) toast.dismiss();
    this.toasts.clear();
  }

  private announce(link: RemoteThreadLink, question: string): void {
    const actions = this.ports.actions();
    const environments = this.ports.environments();
    const title = `${link.title ?? "A thread"} on ${link.machineName} asks`;
    const body = question || "It waits for an answer there.";
    const open = () => {
      this.openThere(link).catch((error: unknown) => actions?.notify(error instanceof Error ? error.message : String(error)));
    };
    if (actions?.toast) {
      const buttons = environments ? [
        { label: `Open on ${link.machineName}`, run: open },
        ...(environments.watchThread ? [{ label: "Look in", run: () => actions.openThread(link.thread!, { pin: true, machine: link.machine }) }] : []),
      ] : [];
      this.toasts.get(link.id)?.dismiss();
      const shown: { handle?: ToastHandle } = {};
      const handle = actions.toast({
        id: `remote-work.question:${link.id}`,
        type: "info",
        title,
        description: body,
        timeoutMs: 0,
        actions: buttons,
        onClose: () => { if (shown.handle && this.toasts.get(link.id) === shown.handle) this.toasts.delete(link.id); },
      });
      shown.handle = handle;
      this.toasts.set(link.id, handle);
    } else actions?.notify(`${title}: ${body}`);
    const attention = this.ports.attention();
    if (!attention || this.ports.focused()) return;
    void attention.notify({ title, body, tag: `tau.remote-work:${link.id}` }).then((outcome) => {
      if (outcome === "clicked" && environments) open();
    });
  }
}
