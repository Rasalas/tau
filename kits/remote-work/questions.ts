import type { PlatformAttention, PlatformEnvironments, ToastHandle, WorkbenchActions } from "tau";
import type { RemoteThreadLink } from "./protocol.js";

export interface QuestionNoticePorts {
  actions(): WorkbenchActions | undefined;
  attention(): PlatformAttention | undefined;
  environments(): PlatformEnvironments | undefined;
  /** Machines Kit's agents connection decides whether this host can open a proxy. */
  connectedAgents?(machine: string): Promise<boolean>;
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
 * system notification when the window is not in front. Connected agents open
 * the thread here; the desktop otherwise follows the machine. The toast goes
 * once the thread moves on.
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

  /** Opens a connected agents thread here, with window navigation as the legacy fallback. */
  async openThere(link: RemoteThreadLink): Promise<void> {
    if (!link.thread) throw new Error("The thread has not started yet.");
    if (this.ports.connectedAgents && await this.ports.connectedAgents(link.machine)) {
      const actions = this.ports.actions();
      if (!actions) throw new Error("This client cannot open the thread yet.");
      // Core's externalThreadPath in src/main/pi-host-support.ts defines this virtual path.
      await actions.switchSession(`tau-thread:machine:${link.machine}~${link.thread}`);
      return;
    }
    const environments = this.ports.environments();
    if (!environments) throw new Error("This client cannot show another machine.");
    await environments.open(link.machine, { threadId: link.thread });
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
