import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { HostCommandError, type HostExtensionContext, type HostMcpTool, type RuntimeSessionInfo, type SecretStore } from "tau/host-extension";
import type { Job, SecretRequest } from "./protocol.js";
import { object, text } from "./validation.js";
import { SECRET_SERVICE } from "./webhooks.js";

/** The only consumer is the host's signature verifier. No general-purpose resolver is exposed. */
export class WebhookSecrets {
  private readonly requests = new Map<string, SecretRequest>();
  private readonly answers = new Map<string, (reference: string | undefined) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly saving = new Set<string>();
  private readonly workspaces = new Map<string, string>();
  private readonly stops: (() => void)[] = [];
  constructor(private readonly context: HostExtensionContext, readonly store: SecretStore | undefined, private readonly job: (id: string) => Job, private readonly bind: (jobId: string, reference: string, valid?: () => boolean) => Promise<void>) {}

  list(): SecretRequest[] { return [...this.requests.values()].map((request) => ({ ...request })); }
  private changed(): void { this.context.emit("secret-requests", this.list()); }
  end(threadId: string): void {
    for (const request of this.requests.values()) if (request.threadId === threadId && request.status === "pending") this.finish(request.id, "ended");
  }
  private finish(id: string, status: SecretRequest["status"], reference?: string): void {
    const request = this.requests.get(id);
    if (!request || request.status !== "pending") return;
    request.status = status;
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    this.answers.get(id)?.(reference); this.answers.delete(id);
    this.changed();
  }

  register(): void {
    const { context } = this;
    context.registerCommand("secret-requests", () => this.list(), { access: "read" });
    context.registerCommand("save-secret", async (input) => {
      const v = object(input, ["id", "value"]);
      const id = text(v.id, "Request ID", 36);
      const value = text(v.value, "Secret", 8192);
      const request = this.requests.get(id);
      if (!request || request.status !== "pending" || request.expiresAt < Date.now()) throw new HostCommandError("This secret request ended.");
      if (!this.store) throw new HostCommandError("No operating-system secret store is available on this host.");
      if (this.saving.has(id)) throw new HostCommandError("The secret is already being saved.");
      this.saving.add(id);
      const reference = randomUUID();
      const item = { service: SECRET_SERVICE, account: reference, label: `Webhook signature: ${this.job(request.jobId).config.name}` };
      try {
        await this.store.set(item, value);
        // Stop may have ended the request while the OS store was answering.
        if (request.status !== "pending") throw new HostCommandError("This secret request ended.");
        const workspaceId = this.workspaces.get(id);
        await this.bind(request.jobId, reference, () => request.status === "pending" && this.job(request.jobId).workspaceId === workspaceId);
        this.finish(id, "saved", reference);
        return { saved: true };
      } catch {
        await this.store.delete(item).catch(() => undefined);
        throw new HostCommandError("Couldn't save the secret. Nothing was sent to the agent. Try again.");
      } finally { this.saving.delete(id); }
    }, { access: "owner" });
    context.registerCommand("decline-secret", (input) => { const v = object(input, ["id"]); this.finish(text(v.id, "Request ID", 36), "declined"); return { declined: true }; }, { access: "owner" });
    const tools = (session: RuntimeSessionInfo): HostMcpTool[] => [{
      name: "request_secret", label: "Request private webhook secret",
      description: "Ask the user for a signature key for an existing webhook automation in this project. The host stores and binds it only to that webhook. Returns an opaque reference, never the key. Does not enable the automation.",
      parameters: Type.Object({ consumer: Type.Literal("webhook-signature"), target: Type.String(), label: Type.String(), reason: Type.String() }),
      execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
        const v = object(input, ["consumer", "target", "label", "reason"]);
        if (v.consumer !== "webhook-signature") throw new HostCommandError("Only webhook-signature is a private secret consumer.");
        if (!this.store) throw new HostCommandError("No operating-system secret store is available on this host.");
        const job = this.job(text(v.target, "Automation ID", 36));
        const path = await context.services.knownWorkspacePath(session.cwd);
        if (job.workspaceId !== context.services.workspaceRef(path).workspaceId || job.config.schedule.kind !== "webhook") throw new HostCommandError("The webhook must belong to this thread's project.");
        if (signal?.aborted) throw new HostCommandError("The secret request ended.");
        if ([...this.requests.values()].some((r) => r.status === "pending" && (r.threadId === session.sessionId || r.jobId === job.id))) throw new HostCommandError("A private secret request is already waiting.");
        const request: SecretRequest = { id: randomUUID(), threadId: session.sessionId, jobId: job.id, label: text(v.label, "Label", 120), reason: text(v.reason, "Reason", 500), status: "pending", expiresAt: Date.now() + 86_400_000 };
        // Keep at most 100 answered requests; no value is ever kept in these records.
        for (const [id, old] of this.requests) if (this.requests.size >= 100 && old.status !== "pending") { this.requests.delete(id); this.workspaces.delete(id); }
        this.requests.set(request.id, request);
        this.workspaces.set(request.id, job.workspaceId);
        const answer = new Promise<string | undefined>((resolve) => this.answers.set(request.id, resolve));
        const cancel = () => this.finish(request.id, "ended");
        signal?.addEventListener("abort", cancel, { once: true });
        this.timers.set(request.id, setTimeout(cancel, 86_400_000));
        this.changed();
        try {
          const reference = await answer;
          const result = reference ? { reference, consumer: "webhook-signature", target: job.id, bound: true } : { status: request.status };
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
        } finally { signal?.removeEventListener("abort", cancel); }
      },
    }];
    this.stops.push(context.services.mcp.registerTools(tools));
    this.stops.push(context.services.registerRuntimeExtension("tau-private-webhook-secrets", (pi, session) => { for (const tool of tools(session)) pi.registerTool(tool); }));
    this.stops.push(context.services.registerThreadLifecycle({ threadDeleted: async (id) => { this.end(id); } }));
  }

  close(): void {
    for (const request of this.requests.values()) this.finish(request.id, "ended");
    for (const stop of this.stops.splice(0)) stop();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
