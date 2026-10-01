import { HostCommandError, type HostExtensionContext, type UiPromptAttachment } from "tau/host-extension";
import { THREAD_MODEL_COMMAND, THREAD_RENAME_COMMAND, THREAD_SEND_COMMAND } from "./protocol.js";

const MAX_TITLE = 120;

function fields(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new HostCommandError(`${name} must be a non-empty string.`);
  return value;
}

/** Only images cross: a file attachment names a path that exists on the sender's disk. */
function images(value: unknown): UiPromptAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HostCommandError("attachments must be an array.");
  return value.map((item): UiPromptAttachment => {
    const image = fields(item);
    if (image.kind !== "image") throw new HostCommandError("Only images can be sent to another machine; embed files in the message.");
    if (typeof image.data !== "string" || typeof image.mimeType !== "string" || typeof image.size !== "number") throw new HostCommandError("An image attachment needs data, mimeType and size.");
    return { kind: "image", name: typeof image.name === "string" ? image.name : "image", mimeType: image.mimeType, data: image.data, size: image.size };
  });
}

/** What a thread's home machine does for another machine's window: its own threads only, never a proxy of a third. */
export function registerThreadCommands(context: HostExtensionContext): void {
  const { services } = context;
  const homeThread = async (input: unknown): Promise<string> => {
    const sessionId = text(fields(input).sessionId, "sessionId");
    const session = (await services.sessions.list()).find((entry) => entry.sessionId === sessionId);
    if (!session) throw new HostCommandError("That thread does not exist on this machine.");
    if (session.path.startsWith("tau-thread:machine:")) throw new HostCommandError("That thread lives on another machine.");
    return sessionId;
  };
  context.registerCommand(THREAD_RENAME_COMMAND, async (input) => {
    const sessionId = await homeThread(input);
    const title = text(fields(input).title, "title").trim();
    if (!title) throw new HostCommandError("Thread titles cannot be empty.");
    if (title.length > MAX_TITLE) throw new HostCommandError(`Thread titles must be ${MAX_TITLE} characters or fewer.`);
    await services.setThreadTitle(sessionId, title, "renamed");
  }, { audit: { label: "renamed a thread from another machine" } });
  context.registerCommand(THREAD_MODEL_COMMAND, async (input) => {
    const sessionId = await homeThread(input);
    const setModel = services.sessions.setModel;
    if (!setModel) throw new HostCommandError("This Tau cannot change the model of a thread that is not on screen.");
    await setModel(sessionId, text(fields(input).provider, "provider"), text(fields(input).id, "id"));
  }, { audit: { label: "changed a thread's model from another machine" } });
  context.registerCommand(THREAD_SEND_COMMAND, async (input) => {
    const sessionId = await homeThread(input);
    const send = services.sessions.send;
    if (!send) throw new HostCommandError("This Tau cannot send images to a thread that is not on screen.");
    const delivery = fields(input).delivery;
    if (delivery !== undefined && delivery !== "prompt" && delivery !== "steer" && delivery !== "queue") throw new HostCommandError('delivery must be "prompt", "steer" or "queue".');
    const message = fields(input).text;
    await send(sessionId, typeof message === "string" ? message : "", { delivery: delivery ?? "prompt", attachments: images(fields(input).attachments) });
  }, { audit: { label: "sent a message with images from another machine" } });
}
