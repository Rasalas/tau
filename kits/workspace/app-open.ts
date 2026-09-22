import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import {
  APP_OPEN_COMMAND,
  OPEN_REQUEST_EVENT,
  TAKE_OPEN_REQUEST_COMMAND,
  type AppOpenResult,
  type OpenRequest,
} from "./storage-protocol.js";

/** A request nobody took within this long is stale: the user has moved on. */
const PENDING_TTL_MS = 2 * 60_000;
/** A window half answers at once; a client without one never does, so the command line does not wait for it. */
const FOCUS_WAIT_MS = 3_000;

/**
 * `tau app <path>`: the command line asks the running host to open a folder.
 * An attached window gets the request as an event and its window half brings
 * it to the front; without one the request waits for the window the command
 * line starts next, which takes it once its desktop half is up.
 */
export function registerAppOpen(context: HostExtensionContext, now: () => number = Date.now): void {
  const { services } = context;
  let pending: OpenRequest | undefined;

  context.registerCommand(APP_OPEN_COMMAND, async (input): Promise<AppOpenResult> => {
    const requested = (input as { path?: unknown } | undefined)?.path;
    if (typeof requested !== "string" || !isAbsolute(requested)) throw new HostCommandError("tau app needs an absolute folder path.");
    const info = await stat(requested).catch(() => undefined);
    if (!info?.isDirectory()) throw new HostCommandError(`${requested} is not a folder.`);
    const ref = services.workspaceRef(await realpath(requested));
    const request: OpenRequest = { workspaceId: ref.workspaceId, displayPath: ref.displayPath, requestedAt: now() };
    services.log("workspace.app-open", ref.displayPath);
    if (services.clients.count() === 0) {
      pending = request;
      return { ...ref, delivered: false, focused: false };
    }
    pending = undefined;
    context.emit(OPEN_REQUEST_EVENT, request);
    // Only the desktop app has a window half; a browser client stays where it is.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const focused = await Promise.race([
      services.callClient("focus").then((answer) => answer === true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), FOCUS_WAIT_MS); }),
    ]).finally(() => clearTimeout(timer));
    return { ...ref, delivered: true, focused };
  });

  context.registerCommand(TAKE_OPEN_REQUEST_COMMAND, () => {
    const request = pending && now() - pending.requestedAt < PENDING_TTL_MS ? pending : undefined;
    pending = undefined;
    return request ?? null;
  });
}
