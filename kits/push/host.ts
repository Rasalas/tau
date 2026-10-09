import { ACTIVITY_BUNDLE, ActivityBundle } from "./activity-bundle.js";
import { ActivityStarts, readActivityStart } from "./activity-start.js";
import { ActivityTokens, readActivityRegistration, type ActivityRow, type ActivityUpdate } from "./mobile-activity.js";
import { createHash } from "node:crypto";
import { HostCommandError, type HostCommandCall, type HostExtension, type HostExtensionContext } from "tau/host-extension";
import { ApnsClient, readApnsKey, type ApnsEnvironment, type SendOutcome } from "./apns.js";
import { composePush, lastAgentText } from "./content.js";
import { FcmClient, readServiceAccount, safeEndpoint } from "./fcm.js";
import {
  ATTENDED_COMMAND,
  NOTIFICATIONS_EXTENSION_ID,
  PUSH_AWAY_KEY,
  PUSH_CONTENT_KEY,
  PUSH_EXTENSION_ID,
  PUSH_RELAY_URL,
  PUSH_STATE_EVENT,
  readAwayMinutes,
  readPushContent,
  threadLink,
  type ApnsKeyInput,
  type FcmKeyInput,
  type PushKind,
  type PushNotifyInput,
  type PushRegisterAnswer,
  type PushRegistration,
  type PushRelayRegistration,
  type PushRoute,
  type PushStatus,
} from "./protocol.js";
import { sealPush, sealedCollapseId, sendThroughRelay } from "./relay.js";
import { PushStore, type StoredDevice } from "./store.js";

const DEFAULT_DEBOUNCE_MS = 5_000;
const APNS_TOKEN = /^[0-9a-f]{32,200}$/iu;
const FCM_TOKEN = /^[\w:.-]{20,4096}$/u;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const HOST_KEY = /^[\w.:-]{1,200}$/u;
const RELAY_HANDLE = /^[A-Za-z0-9_-]{40,6000}$/u;
const RELAY_KEY_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const KINDS: readonly PushKind[] = ["completed", "failed", "turn", "question", "approval"];
const APPROVAL_OPTION = /^(?:allow|approve|deny|reject)\b/iu;
/** Handles the relay called gone, remembered so the phone can be told to renew one it sends again. */
const MAX_REJECTED_HANDLES = 1_000;
/** News unseen this long after it happened is old; the phone no longer hears of it. */
const MAX_WAIT_MS = 12 * 60 * 60_000;

export interface PushHostOptions {
  /** Where APNs requests go instead of Apple (a test's fake); `TAU_PUSH_APNS_ORIGIN` sets it too. */
  apnsOrigin?: string;
  /** Where FCM requests go instead of Google (a test's fake); `TAU_PUSH_FCM_ORIGIN` sets it too. */
  fcmOrigin?: string;
  /** Tau's relay elsewhere (a test's fake); `TAU_PUSH_RELAY_URL` sets it too. https, or http on loopback. */
  relayUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  debounceMs?: number;
  /** Hears of every push a hook started without waiting; a test awaits them. */
  track?(work: Promise<unknown>): void;
}

interface Note {
  title: string;
  body: string;
  threadId?: string;
  kind?: PushKind;
  activity?: ActivityUpdate;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function ownerOnly(call: HostCommandCall | undefined): void {
  if (!call?.owner) throw new HostCommandError("Only this machine's owner can change push notifications (Settings → Push on the host).");
}

/** The relay's half of a registration; one that does not read is left out, not refused. */
function decodeRelay(value: unknown): PushRelayRegistration | undefined {
  const relay = (value ?? {}) as Partial<PushRelayRegistration>;
  if (typeof relay.handle !== "string" || !RELAY_HANDLE.test(relay.handle)) return undefined;
  if (typeof relay.keyId !== "string" || !RELAY_KEY_ID.test(relay.keyId)) return undefined;
  if (typeof relay.key !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(relay.key) || Buffer.from(relay.key, "base64url").length !== 32) return undefined;
  return { handle: relay.handle, keyId: relay.keyId, key: relay.key };
}

function decodeRegistration(input: unknown): PushRegistration {
  const value = (input ?? {}) as Partial<PushRegistration>;
  const platform = value.platform;
  if (platform !== "ios" && platform !== "android") throw new HostCommandError("register takes { platform: ios | android, token?, host, topic?, relay? }.");
  const token = typeof value.token === "string" ? value.token.trim() : undefined;
  if (token !== undefined && !(platform === "ios" ? APNS_TOKEN : FCM_TOKEN).test(token)) throw new HostCommandError(`That is not an ${platform === "ios" ? "APNs device" : "FCM registration"} token.`);
  if (typeof value.host !== "string" || !HOST_KEY.test(value.host)) throw new HostCommandError("register needs the app's id for this host.");
  const topic = typeof value.topic === "string" ? value.topic : undefined;
  if (platform === "ios" && (!topic || !BUNDLE_ID.test(topic))) throw new HostCommandError("An iOS device names its app's bundle identifier as topic.");
  const relay = decodeRelay(value.relay);
  return { platform, ...(token ? { token } : {}), host: value.host, ...(topic && platform === "ios" ? { topic } : {}), ...(relay ? { relay } : {}) };
}

const handleDigest = (handle: string) => createHash("sha256").update(handle).digest("base64url");

/** APNs takes at most 64 bytes; a thread id longer than that is hashed. */
function collapseId(threadId: string): string {
  return Buffer.byteLength(threadId) <= 64 ? threadId : createHash("sha256").update(threadId).digest("hex");
}

function questionText(prompt: { title: string; message?: string }): string {
  return [prompt.title, prompt.message].filter((part) => part?.trim()).join(" — ");
}

/**
 * Push notifications: sent by the host itself with the user's own keys (APNs
 * for the iPhone app, FCM for the Android app), or, for a platform without
 * one, through Tau's relay, sealed with a key only the phone and this host
 * know (docs/push.md). A paired device registers its token over the socket; a
 * turn that ends or fails, a question and an agent's "your turn" reach it
 * while nobody is at a client — Notifications Kit says whether someone is.
 */
export function createPushHostExtension(options: PushHostOptions = {}): HostExtension {
  return {
    id: PUSH_EXTENSION_ID,
    name: "Push",
    permissions: ["sessions", "runtime:extend", "network"],
    isolation: "in-process",
    async activate(context: HostExtensionContext) {
      const { services } = context;
      const now = options.now ?? Date.now;
      const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
      const apnsOrigin = options.apnsOrigin ?? process.env.TAU_PUSH_APNS_ORIGIN;
      const fcmOrigin = options.fcmOrigin ?? process.env.TAU_PUSH_FCM_ORIGIN;
      const relayOverride = options.relayUrl ?? process.env.TAU_PUSH_RELAY_URL;
      if (relayOverride && !safeEndpoint(relayOverride)) services.log("push.relay-url", "TAU_PUSH_RELAY_URL is neither https nor loopback; using Tau's relay.");
      const relayUrl = (relayOverride && safeEndpoint(relayOverride) ? relayOverride : PUSH_RELAY_URL).replace(/\/+$/u, "");
      const store = await PushStore.open(services.stateDir, { warn: (message) => services.log("push.store", message) });
      const activityStarts = await ActivityStarts.open(services.stateDir, { warn: (message) => services.log("push.activity", message) });
      const activityTokens = await ActivityTokens.open(services.stateDir, { warn: (message) => services.log("push.activity", message) });
      let apns: ApnsClient | undefined;
      let fcm: FcmClient | undefined;
      /** Why a saved key did not read; its platform stays on the direct route and fails visibly. */
      let keyErrors: { apns?: string; fcm?: string } = {};
      const lastPushed = new Map<string, number>();
      const rejectedHandles = new Set<string>();

      /** Clients from the stored keys; a key that no longer reads is reported, never printed. */
      const connect = () => {
        apns?.close();
        apns = undefined;
        fcm = undefined;
        keyErrors = {};
        const keys = store.stored;
        if (keys.apns) {
          try {
            apns = new ApnsClient({ credentials: keys.apns, now, ...(apnsOrigin ? { origin: () => apnsOrigin } : {}) });
          } catch (error) {
            keyErrors.apns = errorText(error);
            services.log("push.apns-key", keyErrors.apns);
          }
        }
        if (keys.fcm) {
          try {
            fcm = new FcmClient({ serviceAccount: keys.fcm.serviceAccount, now, ...(fcmOrigin ? { origin: fcmOrigin } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
          } catch (error) {
            keyErrors.fcm = errorText(error);
            services.log("push.fcm-key", keyErrors.fcm);
          }
        }
      };
      connect();

      /** The paired devices, or undefined on a host too old to say. */
      const paired = () => services.clients.devices?.();

      /** A saved key sends directly, and one that does not read fails there rather than falling back to the relay. */
      const routeFor = (platform: StoredDevice["platform"]): PushRoute => ((platform === "ios" ? store.stored.apns : store.stored.fcm) ? "direct" : "relay");
      const deviceRoute = (device: StoredDevice): PushRoute | "unreachable" => {
        const route = routeFor(device.platform);
        return (route === "relay" ? device.relay : device.token) ? route : "unreachable";
      };

      const status = (): PushStatus => {
        const names = new Map((paired() ?? []).map((device) => [device.id, device.name]));
        const { apns: apnsKey, fcm: fcmKey } = store.stored;
        return {
          ...(apnsKey ? { apns: { keyId: apnsKey.keyId, teamId: apnsKey.teamId, savedAt: apnsKey.savedAt, ...(keyErrors.apns ? { error: keyErrors.apns } : {}) } } : {}),
          ...(fcmKey ? { fcm: { projectId: fcmKey.projectId, clientEmail: fcmKey.clientEmail, savedAt: fcmKey.savedAt, ...(keyErrors.fcm ? { error: keyErrors.fcm } : {}) } } : {}),
          devices: store.devices().map((device) => ({
            id: device.id,
            name: names.get(device.id) ?? "Paired device",
            platform: device.platform,
            registeredAt: device.registeredAt,
            route: deviceRoute(device),
            ...(device.lastPush ? { lastPush: device.lastPush } : {}),
          })),
          file: store.keysPath,
          routes: { ios: routeFor("ios"), android: routeFor("android") },
        };
      };
      // Word only: what changed is the owner's to ask for, not every client's to hear.
      const publish = () => context.emit(PUSH_STATE_EVENT);

      /** A revoked or expired device takes its registration with it; only on word of a change, never before the host knows its devices. */
      const prune = async () => {
        const devices = paired();
        if (!devices) return;
        const ids = new Set(devices.map((device) => device.id));
        if (await store.retain((device) => ids.has(device.id))) publish();
      };

      /** Sealed with the phone's key: the relay, Apple and Google see ciphertext and an opaque collapse id. */
      const sendRelayed = (relay: PushRelayRegistration, note: Note, url: string | undefined): Promise<SendOutcome> => {
        const tag = note.threadId ? sealedCollapseId(relay, note.threadId) : undefined;
        const payload = sealPush(relay, { ...(note.activity ? { activity: note.activity } : {}), title: note.title, body: note.body, ...(url ? { url } : {}), ...(note.kind ? { kind: note.kind } : {}), ...(tag ? { tag } : {}) });
        return sendThroughRelay(relayUrl, { handle: relay.handle, payload, ...(tag ? { collapseId: tag } : {}) }, options.fetch).then((outcome) => {
          if (!outcome.ok && outcome.gone) {
            rejectedHandles.add(handleDigest(relay.handle));
            if (rejectedHandles.size > MAX_REJECTED_HANDLES) rejectedHandles.delete(rejectedHandles.values().next().value!);
          }
          return outcome;
        });
      };

      const sendOne = async (device: StoredDevice, note: Note): Promise<SendOutcome> => {
        const url = note.threadId ? threadLink(device.host, note.threadId) : undefined;
        if (routeFor(device.platform) === "relay") {
          if (!device.relay) return { ok: false, gone: false, status: 0, reason: "This phone's Tau app is too old for Tau's relay; update it, or save a key of your own." };
          return sendRelayed(device.relay, note, url);
        }
        if (!device.token) return { ok: false, gone: false, status: 0, reason: "This phone hands its token to your own key the next time it opens this machine in the Tau app." };
        const token = device.token;
        if (device.platform === "android") {
          if (!fcm) return { ok: false, gone: false, status: 0, reason: keyErrors.fcm ? `The saved Firebase service account does not read: ${keyErrors.fcm}` : "No Firebase service account is set up on this host." };
          return fcm.send(token, {
            ...(note.activity ? {} : { notification: { title: note.title, body: note.body } }),
            data: { ...(note.activity ? { activity: JSON.stringify(note.activity) } : {}), ...(url ? { url } : {}), ...(note.kind ? { kind: note.kind } : {}) },
            android: {
              priority: "HIGH",
              ...(note.threadId ? { collapse_key: collapseId(note.threadId) } : {}),
              // Any `android.notification` makes FCM draw one itself; an activity note has no text, so it must have none.
              ...(note.activity ? {} : { notification: { ...(note.threadId ? { tag: collapseId(note.threadId) } : {}) } }),
            },
          });
        }
        if (!apns) return { ok: false, gone: false, status: 0, reason: keyErrors.apns ? `The saved APNs key does not read: ${keyErrors.apns}` : "No APNs key is set up on this host." };
        const request = {
          token,
          topic: device.topic ?? "",
          payload: {
            aps: { alert: { title: note.title, body: note.body }, sound: "default", ...(note.threadId ? { "thread-id": note.threadId } : {}) },
            ...(url ? { url } : {}),
            ...(note.kind ? { kind: note.kind } : {}),
          },
          ...(note.threadId ? { collapseId: collapseId(note.threadId) } : {}),
        };
        // A token from a development build works only in the sandbox; the first success says which.
        const environments: ApnsEnvironment[] = device.environment ? [device.environment] : ["production", "sandbox"];
        let outcome: SendOutcome = { ok: false, gone: false, status: 0, reason: "not sent" };
        for (const environment of environments) {
          // Sequential by design: the sandbox is only asked when production refused the token.
          // oxlint-disable-next-line eslint/no-await-in-loop
          outcome = await apns.send(request, environment);
          if (outcome.ok) {
            if (!device.environment) await store.update(device.id, { environment });
            return outcome;
          }
          if (device.environment || outcome.reason !== "BadDeviceToken") break;
        }
        return outcome;
      };

      const deliver = async (devices: readonly StoredDevice[], note: Note): Promise<SendOutcome[]> => {
        const outcomes = await Promise.all(devices.map(async (device) => {
          const outcome = await sendOne(device, note).catch((error: unknown): SendOutcome => ({ ok: false, gone: false, status: 0, reason: errorText(error) }));
          services.log(outcome.ok ? "push.sent" : "push.failed", `${device.platform} ${device.id}${outcome.ok ? "" : `: ${outcome.reason}`}`);
          await store.update(device.id, { lastPush: { at: new Date(now()).toISOString(), ok: outcome.ok, ...(outcome.ok ? {} : { detail: outcome.reason }) } });
          return outcome;
        }));
        const gone = new Set(devices.filter((_device, index) => {
          const outcome = outcomes[index]!;
          return !outcome.ok && outcome.gone;
        }).map((device) => device.id));
        if (gone.size > 0) await store.retain((device) => !gone.has(device.id));
        publish();
        return outcomes;
      };

      /** Devices still paired that a key of this host or the relay reaches. */
      const reachable = (): StoredDevice[] => {
        const devices = paired();
        const ids = devices ? new Set(devices.map((device) => device.id)) : undefined;
        return store.devices().filter((device) => (!ids || ids.has(device.id)) && deviceRoute(device) !== "unreachable");
      };

      /**
       * Whether the phone should hear now. Like Discord: not while the user is at a Tau client (a key,
       * click or touch within the away time), nor what they silenced (Notifications Kit's switches and
       * quiet hours). `later` is when to ask again; without Notifications Kit nobody can say, so the phone hears.
       */
      const reach = async (threadId: string, kind: PushKind, retry: boolean): Promise<{ send: boolean; laterMs?: number }> => {
        const minutes = readAwayMinutes((await services.settings?.().catch(() => undefined))?.values[PUSH_AWAY_KEY]);
        const awayAfterMs = minutes * 60_000;
        let answer: { attended?: unknown; muted?: unknown; awayInMs?: unknown; unseen?: unknown } | undefined;
        try {
          answer = await context.invokeHostExtension(NOTIFICATIONS_EXTENSION_ID, ATTENDED_COMMAND, { kind: kind === "turn" ? "completed" : kind, threadId, awayAfterMs }) as typeof answer;
        } catch {
          return { send: !retry };
        }
        if (answer?.muted === true) return { send: false };
        // Seen at a client while the push waited: nothing left to tell.
        if (retry && answer?.unseen === false) return { send: false };
        if (answer?.attended !== true) return { send: true };
        return { send: false, laterMs: typeof answer.awayInMs === "number" && answer.awayInMs > 0 ? answer.awayInMs : awayAfterMs };
      };

      /** Pushes held back while the user was at a client, one per thread; newer news replaces older. */
      const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>();
      const wait = (threadId: string, kind: PushKind, text: string | undefined, laterMs: number, since: number) => {
        clearTimeout(waiting.get(threadId)?.timer);
        if (now() - since > MAX_WAIT_MS) { waiting.delete(threadId); return; }
        const timer = setTimeout(() => {
          waiting.delete(threadId);
          raiseLater(threadId, kind, text, since);
        }, laterMs + 1_000);
        timer.unref?.();
        waiting.set(threadId, { timer, since });
      };

      const raise = async (threadId: string, kind: PushKind, text?: string, since?: number): Promise<void> => {
        if (!threadId) return;
        const thread = services.thread(threadId);
        // A sub-agent reports to the thread that spawned it, not to the user.
        if (thread?.parentThreadId) return;
        const targets = reachable();
        if (targets.length === 0) return;
        if (since === undefined) clearTimeout(waiting.get(threadId)?.timer);
        const decision = await reach(threadId, kind, since !== undefined);
        if (decision.laterMs !== undefined) wait(threadId, kind, text, decision.laterMs, since ?? now());
        if (!decision.send) return;
        const last = lastPushed.get(threadId);
        if (last !== undefined && now() - last < debounceMs) return;
        lastPushed.set(threadId, now());
        const content = readPushContent((await services.settings?.().catch(() => undefined))?.values[PUSH_CONTENT_KEY]);
        let said = text;
        if (content === "excerpt" && (kind === "completed" || kind === "failed") && thread) {
          said = lastAgentText(await thread.transcript().catch(() => []));
        }
        const title = thread?.sessionName();
        await deliver(targets, { ...composePush({ kind, ...(title ? { title } : {}), ...(said ? { text: said } : {}) }, content), threadId, kind });
      };
      const raiseLater = (threadId: string, kind: PushKind, text?: string, since?: number) => {
        const work = raise(threadId, kind, text, since).catch((error: unknown) => services.log("push.failed", errorText(error)));
        options.track?.(work);
      };

      const activityTimes = new Map<string, number>();
      const activityStates = new Map<string, ActivityUpdate["state"]>();
      const activityWork = new Map<string, Promise<void>>();
      // An iPhone gets one Live Activity for all of this host's threads (K163); Android a card per thread.
      const bundle = new ActivityBundle(now);
      const pushBundle = async () => {
        const pairedIds = new Set((paired() ?? []).map((device) => device.id));
        const content = bundle.content();
        const at = Math.max(now(), (activityTimes.get(ACTIVITY_BUNDLE) ?? 0) + 1000);
        activityTimes.set(ACTIVITY_BUNDLE, at);
        activityStates.set(ACTIVITY_BUNDLE, content.state);
        await activityStarts.note(ACTIVITY_BUNDLE, content.state);
        if (content.state !== "completed") await activityStarts.start(ACTIVITY_BUNDLE, content.title, now(), pairedIds, (id) => activityTokens.has(id, ACTIVITY_BUNDLE), (request) => sendThroughRelay(relayUrl, request, options.fetch), content.threads);
        await activityTokens.update(ACTIVITY_BUNDLE, content.state, content.title, at, pairedIds,
          (id) => store.devices().find((device) => device.id === id)?.environment,
          (request, environment) => apns ? apns.send(request, environment) : Promise.resolve({ ok: false, gone: false, status: 0, reason: "No APNs key." }),
          (request) => sendThroughRelay(relayUrl, request, options.fetch), undefined, content.threads);
        if (content.state === "completed") bundle.reset();
      };
      const updateActivity = async (threadId: string, state: ActivityUpdate["state"], row: { state: ActivityRow["state"]; reason?: string }) => {
        const targets = reachable();
        const title = (services.thread(threadId)?.sessionName() ?? "Agent work").slice(0, 100);
        const at = Math.max(now(), (activityTimes.get(threadId) ?? 0) + 1000);
        activityTimes.set(threadId, at);
        if (!services.thread(threadId)?.parentThreadId) {
          bundle.note(threadId, row.state, title, row.reason);
          await pushBundle();
        }
        await Promise.all(targets.filter((device) => device.platform === "android" && device.activities).map((device) => sendOne(device, {
          title, body: state === "running" ? "Agent working" : state === "needs-input" ? "Your input needed" : "Completed", threadId,
          activity: { version: 1, hostId: device.host, threadId, title, state, updatedAt: at, expiresAt: at + (state === "running" ? 8 * 60 * 60_000 : 15 * 60_000) },
        })));
      };
      const activityLater = (threadId: string, state: ActivityUpdate["state"], row: { state: ActivityRow["state"]; reason?: string }) => {
        activityStates.set(threadId, state);
        // One queue for all threads: the bundle's rows are written in order.
        const work = (activityWork.get(ACTIVITY_BUNDLE) ?? Promise.resolve()).then(() => updateActivity(threadId, state, row)).catch((error: unknown) => services.log("push.activity", errorText(error)));
        activityWork.set(ACTIVITY_BUNDLE, work);
        void work.then(() => { if (activityWork.get(ACTIVITY_BUNDLE) === work) activityWork.delete(ACTIVITY_BUNDLE); });
        options.track?.(work);
      };
      context.registerCommand("activity-enable", async (_input, call) => {
        if (!call?.device) throw new HostCommandError("Only a paired device can enable its activity cards.");
        const saved = store.devices().find((device) => device.id === call.device);
        if (saved?.platform === "android") await store.update(saved.id, { activities: true });
        return { enabled: saved?.platform === "android" };
      });
      context.registerCommand("activity-start-register", async (input, call) => {
        if (!call?.device) throw new HostCommandError("Only a paired phone can enable remote Live Activities.");
        const registration = readActivityStart(input, call.device, now());
        const saved = store.devices().find((device) => device.id === call.device);
        if (!saved || saved.platform !== "ios" || saved.host !== registration.hostId || saved.topic !== registration.topic) throw new HostCommandError("The remote activity must belong to this registered phone.");
        await activityStarts.register(registration);
        return { registered: true };
      });
      context.registerCommand("activity-finish", async (input, call) => {
        if (!call?.device) throw new HostCommandError("Only a paired phone can finish its activity.");
        const id = (input as { activityId?: unknown } | undefined)?.activityId;
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(id)) throw new HostCommandError("An activity id is required.");
        await activityTokens.finish(call.device, id); return { finished: true };
      });
      context.registerCommand("activity-disable", async (_input, call) => {
        if (!call?.device) throw new HostCommandError("Only a paired phone can disable its remote activities.");
        await activityStarts.remove(call.device);
        await activityTokens.remove(call.device);
        return { enabled: false };
      });
      context.registerCommand("activity-register", async (input, call) => {
        if (!call?.device) throw new HostCommandError("Only a paired device can register its activity token.");
        const registration = readActivityRegistration(input, call.device, now());
        const saved = store.devices().find((device) => device.id === call.device);
        if (!saved || saved.platform !== "ios" || saved.host !== registration.hostId || saved.topic !== registration.topic) throw new HostCommandError("The activity must belong to this device's registered host and app.");
        if (registration.activityId && !activityStarts.owns(registration, now())) throw new HostCommandError("This activity was not started for this phone and key.");
        if (registration.activityId) registration.expiresAt = Math.min(registration.expiresAt, activityStarts.expiry(registration));
        await activityTokens.register(registration);
        const state = registration.activityId ? activityStarts.state(registration) : activityStates.get(registration.threadId);
        if (state && registration.threadId === ACTIVITY_BUNDLE) {
          // A token that arrives late gets what the activity should show now.
          const content = bundle.content();
          const at = Math.max(now(), (activityTimes.get(ACTIVITY_BUNDLE) ?? 0) + 1000);
          activityTimes.set(ACTIVITY_BUNDLE, at);
          const work = activityTokens.update(ACTIVITY_BUNDLE, registration.activityId ? state : content.state, content.title, at,
            new Set((paired() ?? []).map((device) => device.id)), (id) => store.devices().find((device) => device.id === id)?.environment,
            (request, environment) => apns ? apns.send(request, environment) : Promise.resolve({ ok: false, gone: false, status: 0, reason: "No APNs key." }),
            (request) => sendThroughRelay(relayUrl, request, options.fetch), registration.activityId, content.threads);
          options.track?.(work); await work;
        }
        return { registered: true, ready: Boolean(registration.relay || apns) };
      });

      const stops = [
        services.registerTurnObserver({
          prepare: async (sessionId) => activityLater(sessionId, "running", { state: "running" }),
          runEnded: (sessionId, outcome) => {
            activityLater(sessionId, outcome === "failed" ? "needs-input" : "completed", outcome === "failed" ? { state: "failed", reason: "The turn failed" } : { state: "done" });
            raiseLater(sessionId, outcome === "failed" ? "failed" : "completed");
          },
        }),
        services.decorateUiPrompt((prompt) => {
          activityLater(prompt.sessionId, "needs-input", { state: "waiting", reason: questionText(prompt) });
          const approval = prompt.kind === "confirm" || (prompt.kind === "select" && prompt.options?.some((option) => APPROVAL_OPTION.test(option)));
          raiseLater(prompt.sessionId, approval ? "approval" : "question", questionText(prompt));
        }),
        services.registerThreadLifecycle({ threadDeleted: async (sessionId) => { lastPushed.delete(sessionId); } }),
        services.clients.observe({
          devicesChanged: () => {
            // Started before handing it over: `track?.(prune())` would skip the prune without a tracker.
            const work = Promise.all([prune(), activityTokens.retain(new Set((paired() ?? []).map((device) => device.id)), now()), activityStarts.retain(new Set((paired() ?? []).map((device) => device.id)), now())]).catch((error: unknown) => services.log("push.store", errorText(error)));
            options.track?.(work);
          },
        }),
      ];

      context.registerCommand("register", async (input, call) => {
        if (!call?.device) throw new HostCommandError("Only a paired device can receive push notifications from this host.");
        const { token, relay, ...registration } = decodeRegistration(input);
        const route = routeFor(registration.platform);
        // A token only for this host's own key; a handle the relay refused is not kept.
        const renewHandle = relay ? rejectedHandles.has(handleDigest(relay.handle)) : false;
        // Until the phone confirms it, the direct route keeps the token it had.
        const prior = store.devices().find((entry) => entry.id === call.device && entry.platform === registration.platform);
        const kept = route === "direct" ? token ?? prior?.token : undefined;
        const device: StoredDevice = {
          id: call.device,
          ...registration,
          ...(kept ? { token: kept } : {}),
          ...(relay && !renewHandle ? { relay } : {}),
          registeredAt: new Date(now()).toISOString(),
        };
        await store.upsert(device);
        services.log("push.registered", `${registration.platform} ${call.device} ${route}`);
        publish();
        const answer: PushRegisterAnswer = {
          registered: true,
          ready: deviceRoute(device) !== "unreachable",
          route,
          ...(route === "direct" && !token ? { needsToken: true } : {}),
          ...(renewHandle ? { renewHandle: true } : {}),
        };
        return answer;
      });
      context.registerCommand("unregister", async (_input, call) => {
        if (!call?.device) return false;
        const device = call.device;
        await activityStarts.remove(device); await activityTokens.remove(device);
        const gone = await store.retain((entry) => entry.id !== device);
        if (gone) publish();
        return gone;
      });
      context.registerCommand("status", (_input, call) => {
        ownerOnly(call);
        return status();
      });
      context.registerCommand("set-apns", async (input, call) => {
        ownerOnly(call);
        const value = (input ?? {}) as Partial<ApnsKeyInput>;
        const credentials = { keyId: String(value.keyId ?? "").trim().toUpperCase(), teamId: String(value.teamId ?? "").trim().toUpperCase(), key: String(value.key ?? "").trim() };
        try { readApnsKey(credentials); } catch (error) { throw new HostCommandError(errorText(error)); }
        await store.setKeys({ ...store.stored, apns: { ...credentials, savedAt: new Date(now()).toISOString() } });
        connect();
        services.log("push.apns-saved", credentials.keyId);
        publish();
        return status();
      });
      context.registerCommand("set-fcm", async (input, call) => {
        ownerOnly(call);
        const text = String((input as Partial<FcmKeyInput> | undefined)?.serviceAccount ?? "").trim();
        let account;
        try { ({ account } = readServiceAccount(text)); } catch (error) { throw new HostCommandError(errorText(error)); }
        await store.setKeys({ ...store.stored, fcm: { serviceAccount: text, projectId: account.projectId, clientEmail: account.clientEmail, savedAt: new Date(now()).toISOString() } });
        connect();
        services.log("push.fcm-saved", account.projectId);
        publish();
        return status();
      });
      context.registerCommand("forget", async (input, call) => {
        ownerOnly(call);
        const service = (input as { service?: unknown } | undefined)?.service;
        if (service !== "apns" && service !== "fcm") throw new HostCommandError("forget takes { service: apns | fcm }.");
        const { [service]: _dropped, ...rest } = store.stored;
        await store.setKeys(rest);
        await store.dropTokens(service === "apns" ? "ios" : "android");
        connect();
        publish();
        return status();
      });
      context.registerCommand("remove-device", async (input, call) => {
        ownerOnly(call);
        const id = (input as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string") throw new HostCommandError("remove-device takes { id }.");
        await activityStarts.remove(id); await activityTokens.remove(id);
        await store.retain((device) => device.id !== id);
        publish();
        return status();
      });
      context.registerCommand("test", async (input, call) => {
        ownerOnly(call);
        const id = (input as { id?: unknown } | undefined)?.id;
        const device = store.devices().find((entry) => entry.id === id);
        if (!device) throw new HostCommandError("That device has not asked for push notifications.");
        const [outcome] = await deliver([device], { title: "Tau", body: "Push notifications reach this device." });
        return outcome!.ok ? { ok: true } : { ok: false, detail: (outcome as { reason: string }).reason };
      });
      context.registerCommand("notify", async (input, call) => {
        // Kits only: a client asking would push its own words to every phone.
        if (!call?.extension) throw new HostCommandError("notify is for other kits.");
        const value = (input ?? {}) as Partial<PushNotifyInput>;
        if (typeof value.threadId !== "string" || !KINDS.includes(value.kind as PushKind)) throw new HostCommandError("notify takes { threadId, kind, text? }.");
        await raise(value.threadId, value.kind as PushKind, typeof value.text === "string" ? value.text : undefined);
      }, { callers: ["tau.takeover"] });

      return () => {
        for (const stop of stops) stop();
        for (const { timer } of waiting.values()) clearTimeout(timer);
        apns?.close();
      };
    },
  };
}

export default createPushHostExtension;
