import { join } from "node:path";
import { Type } from "typebox";
import { HostCommandError, type HostExtension, type HostMcpTool, type RuntimeSessionInfo } from "tau/host-extension";
import { SecretFiles } from "./files.js";
import { PRIVATE_SECRETS_ID } from "./protocol.js";

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostCommandError("Expected a private file request.");
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string, limit: number): string => {
  // oxlint-disable-next-line eslint/no-control-regex -- Reject nonprinting characters in request metadata.
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x08\x0b-\x1f\x7f]/u.test(value)) throw new HostCommandError(`Enter a valid ${name}.`);
  return value.trim();
};

export default function privateSecretsHost(): HostExtension {
  return {
    id: PRIVATE_SECRETS_ID, name: "Private secrets", permissions: ["sessions", "runtime:extend"],
    async activate(context) {
      const files = await SecretFiles.open(join(context.services.stateDir, "files"), () => context.emit("changed"));
      context.registerCommand("state", (_input, call) => ({ canManage: call.owner, requests: files.list() }), { access: "read" });
      context.registerCommand("submit", async (input) => {
        const v = record(input);
        if (v.lifetimeMinutes !== undefined && typeof v.lifetimeMinutes !== "number") throw new HostCommandError("Choose a valid private file lifetime.");
        await files.submit(text(v.id, "request ID", 36), v.value, v.lifetimeMinutes);
        return { saved: true };
      }, { access: "owner" });
      context.registerCommand("decline", async (input) => { await files.decline(text(record(input).id, "request ID", 36)); return { declined: true }; }, { access: "owner" });
      context.registerCommand("revoke", async (input) => { await files.revoke(text(record(input).id, "request ID", 36)); return { revoked: true }; }, { access: "owner" });
      context.offer("tau.thread-rail/archive");
      context.registerCommand("thread-archived", async (input, call) => {
        if (call.extension !== "tau.thread-rail") throw new HostCommandError("This cleanup belongs to the thread lifecycle.");
        await files.end(text(record(input).threadId, "thread ID", 256));
      }, { callers: ["tau.thread-rail"] });
      const tools = (session: RuntimeSessionInfo): HostMcpTool[] => [{
        name: "request_secret_file", label: "Request private secret file", annotations: { readOnlyHint: false },
        description: "Ask the user privately for a secret needed by a shell CLI in this thread. Delivery is a private file: returns its path and opaque reference, never the value in chat. Pass the file to the CLI, or read it inside your shell command. Never print the value or copy it into chat. Files remain available across runs until expiry, manual revocation, thread archiving or deletion. Request only immediately before the command that needs it. The user may shorten the lifetime.",
        parameters: Type.Object({ delivery: Type.Optional(Type.Literal("file")), label: Type.String(), reason: Type.String(), filename: Type.Optional(Type.String()), lifetimeMinutes: Type.Optional(Type.Integer({ minimum: 15, maximum: 1440 })) }),
        execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
          const v = record(input);
          if (v.delivery !== undefined && v.delivery !== "file") throw new HostCommandError("Private command secrets use file delivery.");
          const filename = v.filename === undefined ? "secret.txt" : text(v.filename, "filename", 64);
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(filename)) throw new HostCommandError("Use a filename without folders or spaces.");
          const lifetimeMinutes = v.lifetimeMinutes ?? 60;
          if (typeof lifetimeMinutes !== "number" || !Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 15 || lifetimeMinutes > 1440) throw new HostCommandError("Choose a lifetime between 15 minutes and 24 hours.");
          const result = await files.request(session.sessionId, { label: text(v.label, "label", 120), reason: text(v.reason, "reason", 500), filename, lifetimeMinutes }, signal);
          const answer = result ? { status: "saved", file: result.path, secretRef: result.secretRef, expiresAt: result.expiresAt } : { status: "ended" };
          return { content: [{ type: "text", text: JSON.stringify(answer) }], details: answer };
        },
      }, {
        name: "release_secret_file", label: "Release private secret file", annotations: { readOnlyHint: false },
        description: "Delete a private secret file requested by this thread after the CLI no longer needs it. Accepts its opaque reference, never a path or secret value.",
        parameters: Type.Object({ secretRef: Type.String() }),
        execute: async (_id: string, input: unknown) => {
          await files.release(session.sessionId, text(record(input).secretRef, "secret reference", 36));
          return { content: [{ type: "text", text: "Private secret file removed." }], details: { released: true } };
        },
      }];
      const stopMcp = context.services.mcp.registerTools(tools);
      const stopRuntime = context.services.registerRuntimeExtension(PRIVATE_SECRETS_ID, (pi, session) => { for (const tool of tools(session)) pi.registerTool(tool); });
      const stopObserver = context.services.registerTurnObserver({
        stopped: async (id) => { await files.cancelPending(id); }, closed: (id) => files.cancelPending(id), reset: (id) => files.cancelPending(id),
        runEnded: (id) => { void files.cancelPending(id).catch(() => context.services.log("secrets.cleanup", "A private file could not be removed. Revoke it to retry.")); },
      });
      const stopLifecycle = context.services.registerThreadLifecycle({ beforeRemove: (id) => files.end(id), threadDeleted: (id) => files.end(id) });
      return async () => { stopMcp(); stopRuntime(); stopObserver(); stopLifecycle(); await files.close(); };
    },
  };
}
