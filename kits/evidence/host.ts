import type { HostExtension, HostExtensionContext, RuntimeExtensionFactory } from "tau/host-extension";
import { EvidenceCapture } from "./capture.js";
import {
  COMPUTER_USE_EXTENSION_ID,
  DEFAULT_SETTINGS,
  EVIDENCE_CHANGED_EVENT,
  EVIDENCE_EXTENSION_ID,
  EVIDENCE_PAUSE_CALLERS,
  EVIDENCE_PAUSED_EVENT,
  FRAME_WIDTH,
  PREVIEW_EXTENSION_ID,
  THUMB_WIDTH,
  readEvidenceSettings,
  type EncodedFrame,
  type EvidenceSettings,
  type PreviewEvidenceFrame,
  type ScreenFrame,
  type ScreenState,
} from "./protocol.js";
import { EvidenceStore } from "./store.js";
import { attachEvidenceTool } from "./tools.js";

const SETTINGS_FRESH_MS = 5_000;
const SWEEP_FIRST_MS = 60_000;
const SWEEP_EVERY_MS = 6 * 60 * 60_000;

type WindowCall = (command: string, input?: unknown) => Promise<unknown>;

/** The window half, or the same module loaded here when the host runs in the window's process. */
function windowCalls(context: HostExtensionContext): WindowCall {
  let local: Promise<WindowCall> | undefined;
  return (command, input) => {
    if (process.type !== "browser") return context.services.callClient(command, input);
    local ??= import("./window.js").then(({ default: activate }) => {
      const half = activate({ id: EVIDENCE_EXTENSION_ID, invokeHost: () => Promise.reject(new Error("No host commands from here.")), log: () => undefined });
      return async (next: string, nextInput?: unknown) => half.handle(next, nextInput);
    });
    return local.then((call) => call(command, input));
  };
}

const field = (input: unknown, key: string): string => {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  if (typeof value !== "string" || !value) throw new Error(`Evidence needs ${key}.`);
  return value;
};

/**
 * Evidence Kit's host entry: pictures of what the agent changed, per turn —
 * the Preview's page and the window it drives — kept under the kit's own
 * state folder within the limits the project sets, offered to other kits as
 * turn attachments, and the `attach_evidence` tool for Pi and over MCP.
 */
export function createEvidenceHostExtension(): HostExtension {
  return {
    id: EVIDENCE_EXTENSION_ID,
    name: "Evidence",
    permissions: ["sessions", "runtime:extend"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      const log = (label: string, detail?: string) => services.log(label, detail);
      const store = new EvidenceStore(services.stateDir, log);
      const callWindow = windowCalls(context);

      const settingsCache = new Map<string, { at: number; value: Promise<EvidenceSettings> }>();
      const settings = (cwd: string): Promise<EvidenceSettings> => {
        const cached = settingsCache.get(cwd);
        if (cached && Date.now() - cached.at < SETTINGS_FRESH_MS) return cached.value;
        const value = services.settings
          ? services.settings(cwd || undefined).then(readEvidenceSettings, () => DEFAULT_SETTINGS)
          : Promise.resolve(DEFAULT_SETTINGS);
        settingsCache.set(cwd, { at: Date.now(), value });
        return value;
      };
      const changed = (threadId: string) => {
        context.emit(EVIDENCE_CHANGED_EVENT, { threadId });
        services.turnAttachments?.changed(threadId);
      };

      const capture = new EvidenceCapture({
        store,
        settings,
        preview: () => context.invokeHostExtension(PREVIEW_EXTENSION_ID, "evidence-frame", { maxWidth: FRAME_WIDTH }) as Promise<PreviewEvidenceFrame>,
        screenState: (threadId) => context.invokeHostExtension(COMPUTER_USE_EXTENSION_ID, "screen-state", { threadId }) as Promise<ScreenState | null>,
        screenFrame: (threadId, seq) => context.invokeHostExtension(COMPUTER_USE_EXTENSION_ID, "screen-frame", { threadId, seq }) as Promise<ScreenFrame | null>,
        encode: (data) => callWindow("encode", { data, width: FRAME_WIDTH, thumbWidth: THUMB_WIDTH }) as Promise<EncodedFrame>,
        cwdOf: (threadId) => services.thread(threadId)?.cwd,
        changed,
        now: () => Date.now(),
        log,
      });

      const disposers: Array<() => void> = [];
      disposers.push(services.registerTurnObserver({
        accepted: (threadId, turnId, options) => capture.accepted(threadId, turnId, options),
        prepare: (threadId, turnId) => capture.prepare(threadId, turnId),
        cancelled: async (threadId, turnId) => capture.cancelled(threadId, turnId),
        ended: (threadId, turnId) => capture.ended(threadId, turnId),
        closed: async (threadId) => capture.closed(threadId),
        toolEnded: (threadId, tool, cwd) => capture.toolEnded(threadId, tool, cwd),
      }));
      // A thread in the trash keeps its pictures; only a purge takes them.
      disposers.push(services.registerThreadLifecycle({
        threadDeleted: async (threadId) => {
          await store.deleteThread(threadId);
          changed(threadId);
        },
      }));

      const sweep = () => {
        void store.sweep(async (cwd) => (await settings(cwd)).retentionDays)
          .then((threads) => { for (const threadId of threads) changed(threadId); })
          .catch((error: unknown) => log("evidence.sweep-failed", error instanceof Error ? error.message : String(error)));
      };
      const firstSweep = setTimeout(sweep, SWEEP_FIRST_MS);
      firstSweep.unref?.();
      const sweeper = setInterval(sweep, SWEEP_EVERY_MS);
      sweeper.unref?.();
      disposers.push(() => { clearTimeout(firstSweep); clearInterval(sweeper); });

      const withdraw = services.turnAttachments?.provide({
        list: async (threadId) => (await store.list(threadId)).turns.flatMap((turn) => turn.frames.map((frame) => ({
          id: frame.id,
          turnId: turn.turnId,
          turnStartedAt: turn.startedAt,
          ...(turn.endedAt === undefined ? {} : { turnEndedAt: turn.endedAt }),
          at: frame.at,
          mediaType: frame.mediaType,
          size: frame.size,
          width: frame.width,
          height: frame.height,
          caption: frame.caption,
        }))),
        read: async (threadId, id) => {
          const bytes = await store.image(threadId, id);
          return bytes ? { mediaType: "image/jpeg", data: bytes.toString("base64") } : undefined;
        },
      });
      if (withdraw) disposers.push(withdraw);

      context.registerCommand("list", (input) => store.list(field(input, "threadId")), { access: "read" });
      context.registerCommand("image", async (input) => {
        const thumb = Boolean(input && typeof input === "object" && (input as { thumb?: unknown }).thumb === true);
        const bytes = await store.image(field(input, "threadId"), field(input, "id"), thumb);
        return bytes ? `data:image/jpeg;base64,${bytes.toString("base64")}` : null;
      }, { access: "read" });
      context.registerCommand("delete-turn", async (input) => {
        const threadId = field(input, "threadId");
        if (await store.deleteTurn(threadId, field(input, "turnId"))) changed(threadId);
      });
      const pauses = () => context.emit(EVIDENCE_PAUSED_EVENT, { paused: capture.paused() });
      context.registerCommand("pause", (input) => {
        const reason = input && typeof input === "object" ? (input as { reason?: unknown }).reason : undefined;
        capture.pause(field(input, "threadId"), typeof reason === "string" ? reason : "");
        pauses();
      }, { callers: EVIDENCE_PAUSE_CALLERS });
      context.registerCommand("resume", (input) => {
        capture.resume(field(input, "threadId"));
        pauses();
      }, { callers: EVIDENCE_PAUSE_CALLERS });
      context.registerCommand("paused", () => capture.paused(), { access: "read" });

      const factory: RuntimeExtensionFactory = (pi, session) => {
        pi.registerTool(attachEvidenceTool((caption, source, threadId) => capture.attach(threadId ?? session.sessionId, session.cwd, caption, source)));
      };
      disposers.push(services.registerRuntimeExtension("tau-evidence", factory));
      disposers.push(services.mcp.registerTools((thread) => [
        attachEvidenceTool((caption, source) => capture.attach(thread.sessionId, thread.cwd, caption, source)),
      ]));

      return () => { for (const dispose of disposers.reverse()) dispose(); };
    },
  };
}

export default createEvidenceHostExtension;
