import { join } from "node:path";
import type { HostExtension, HostExtensionContext } from "tau/host-extension";
import {
  CAPTURED_COMMAND,
  SHORTCUT_EVENT,
  SNAPSHOTS_EXTENSION_ID,
  SNAPSHOT_EVENT,
  SNAPSHOT_FAILED_EVENT,
  type ArmInput,
  type PermissionKind,
  type ShortcutState,
  type SnapShotAccess,
  type SnapShotCapture,
  type SnapShotTarget,
} from "./protocol.js";
import { SnapShotStore } from "./store.js";

/** A capture from the window arrives over the socket; its picture is at most this big. */
const MAX_IMAGE_BASE64 = 24 * 1024 * 1024;
const UNSUPPORTED: SnapShotAccess = { supported: false, screen: "unavailable", accessibility: "unavailable" };

const text = (value: unknown, max: number): string => typeof value === "string" ? value.slice(0, max) : "";

/** What the window half sent, checked: a picture of a sane size and a tree that is an object. */
export function decodeCapture(value: unknown): SnapShotCapture {
  const capture = value as Partial<SnapShotCapture> | null;
  const image = capture?.image;
  if (!capture || !image || typeof image.data !== "string" || !image.data || image.data.length > MAX_IMAGE_BASE64) throw new Error("The capture carried no picture.");
  if (!/^image\/(?:png|jpeg)$/u.test(String(image.mimeType))) throw new Error("The capture is not a PNG or JPEG picture.");
  if (![image.width, image.height].every((size) => typeof size === "number" && Number.isInteger(size) && size > 0)) throw new Error("The capture has no size.");
  const accessibility = capture.accessibility;
  const tree = accessibility && typeof accessibility === "object" && accessibility.root && typeof accessibility.root === "object" ? accessibility : undefined;
  return {
    app: text(capture.app, 255) || "Window",
    title: text(capture.title, 1_000),
    pid: typeof capture.pid === "number" ? capture.pid : 0,
    capturedAt: typeof capture.capturedAt === "number" ? capture.capturedAt : Date.now(),
    image: { data: image.data, mimeType: image.mimeType, width: image.width, height: image.height },
    ...(tree ? { accessibility: tree } : {}),
    ...(capture.accessibilityNote ? { accessibilityNote: text(capture.accessibilityNote, 500) } : {}),
  };
}

function targetOf(value: unknown): SnapShotTarget | undefined {
  const target = (value as { target?: Partial<SnapShotTarget> } | undefined)?.target;
  if (target === undefined) return undefined;
  if (typeof target?.windowId !== "number" || typeof target.pid !== "number") throw new Error("Name a window by its number and its process.");
  return { windowId: target.windowId, pid: target.pid };
}

const idsOf = (value: unknown): string[] => {
  const ids = (value as { ids?: unknown } | undefined)?.ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
};

const kindOf = (value: unknown): PermissionKind => {
  const kind = (value as { kind?: unknown } | undefined)?.kind;
  if (kind !== "screen" && kind !== "accessibility") throw new Error("Name the permission: screen or accessibility.");
  return kind;
};

type WindowCall = (command: string, input?: unknown) => Promise<unknown>;

/**
 * The window half runs where the user's windows are. A host inside the
 * window's own process (the in-process fallback) loads it directly.
 */
function windowCalls(context: HostExtensionContext, local: (command: string, input: unknown) => Promise<unknown>): WindowCall {
  let direct: Promise<WindowCall> | undefined;
  return (command, input) => {
    if (process.type !== "browser") return context.services.callClient(command, input);
    direct ??= import("./window.js").then(({ default: activate }) => {
      const half = activate({
        id: SNAPSHOTS_EXTENSION_ID,
        invokeHost: local,
        log: (label, detail) => context.services.log(`snapshots.${label}`, detail),
        loadDependency: (name) => context.services.loadDependency(name),
      });
      return async (next: string, nextInput?: unknown) => half.handle(next, nextInput);
    });
    return direct.then((call) => call(command, input));
  };
}

/**
 * SnapShots' host half: keeps the captures a composer has not sent yet under
 * the kit's state folder, hands them to the first client that shows a
 * composer, and passes the shortcut and the permissions on to the window half.
 */
export function createSnapShotsHostExtension(): HostExtension {
  return {
    id: SNAPSHOTS_EXTENSION_ID,
    name: "SnapShots",
    permissions: [],
    async activate(context: HostExtensionContext) {
      const store = new SnapShotStore(join(context.services.stateDir, "captures"));
      await store.load();
      let shortcut: ShortcutState = {};
      const commands = new Map<string, (input: unknown) => unknown>();
      const register = (name: string, handler: (input: unknown) => unknown) => {
        commands.set(name, handler);
        context.registerCommand(name, handler);
      };
      const callWindow = windowCalls(context, async (command, input) => {
        const handler = commands.get(command);
        if (!handler) throw new Error(`SnapShots has no command "${command}".`);
        return handler(input);
      });

      const accept = async (capture: SnapShotCapture) => {
        const meta = await store.add(capture);
        context.emit(SNAPSHOT_EVENT, meta);
        return meta;
      };

      register("capture", async (input) => {
        const accessibility = (input as { accessibility?: unknown } | undefined)?.accessibility !== false;
        const target = targetOf(input);
        return accept(decodeCapture(await callWindow("capture", { ...(target ? { target } : {}), accessibility })));
      });
      // The window half's own report after the shortcut fired.
      register(CAPTURED_COMMAND, async (input) => {
        const { capture, error } = (input ?? {}) as { capture?: unknown; error?: unknown };
        if (typeof error === "string") {
          context.emit(SNAPSHOT_FAILED_EVENT, { message: error });
          return undefined;
        }
        try {
          return await accept(decodeCapture(capture));
        } catch (failure) {
          context.emit(SNAPSHOT_FAILED_EVENT, { message: failure instanceof Error ? failure.message : String(failure) });
          return undefined;
        }
      });
      register("pending", () => store.list().filter((meta) => !meta.claimed));
      register("claim", async (input) => await store.claim(String((input as { id?: unknown } | undefined)?.id)) ?? null);
      register("meta", (input) => idsOf(input).map((id) => store.meta(id) ?? null));
      register("read", async (input) => await store.read(String((input as { id?: unknown } | undefined)?.id)) ?? null);
      register("release", async (input) => {
        for (const id of idsOf(input)) await store.remove(id);
      });
      register("arm", async (input) => {
        const { accelerator, accessibility } = (input ?? {}) as Partial<ArmInput>;
        try {
          shortcut = await callWindow("shortcut", { accelerator: typeof accelerator === "string" ? accelerator : null, accessibility: accessibility !== false }) as ShortcutState;
        } catch (error) {
          shortcut = { error: error instanceof Error ? error.message : String(error) };
        }
        context.emit(SHORTCUT_EVENT, shortcut);
        return shortcut;
      });
      register("shortcut-state", () => shortcut);
      register("access", async () => {
        try {
          return await callWindow("access") as SnapShotAccess;
        } catch {
          return UNSUPPORTED;
        }
      });
      register("request-access", (input) => callWindow("request-access", { kind: kindOf(input) }));
      register("open-settings", (input) => callWindow("open-settings", { kind: kindOf(input) }));

      return () => {
        // A shortcut must not outlive the kit that owns it.
        void callWindow("shortcut", { accelerator: null, accessibility: false }).catch(() => undefined);
      };
    },
  };
}

export default createSnapShotsHostExtension;
