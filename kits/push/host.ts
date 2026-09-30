import { createHash } from "node:crypto";
import { HostCommandError, type HostCommandCall, type HostExtension, type HostExtensionContext } from "tau/host-extension";
import { ApnsClient, readApnsKey, type ApnsEnvironment, type SendOutcome } from "./apns.js";
import { composePush, lastAgentText } from "./content.js";
import { FcmClient, readServiceAccount, safeEndpoint } from "./fcm.js";
import {
  ATTENDED_COMMAND,
  NOTIFICATIONS_EXTENSION_ID,
  PUSH_CONTENT_KEY,
  PUSH_EXTENSION_ID,
  PUSH_RELAY_URL,
  PUSH_STATE_EVENT,
  readPushContent,
  threadLink,
  type ApnsKeyInput,
  type FcmKeyInput,
  type PushKind,
  type PushNotifyInput,
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
  if (platform !== "ios" && platform !== "android") throw new HostCommandError("register takes { platform: ios | android, token, host, topic? }.");
  const token = typeof value.token === "string" ? value.token.trim() : "";
  if (!(platform === "ios" ? APNS_TOKEN : FCM_TOKEN).test(token)) throw new HostCommandError(`That is not an ${platform === "ios" ? "APNs device" : "FCM registration"} token.`);
  if (typeof value.host !== "string" || !HOST_KEY.test(value.host)) throw new HostCommandError("register needs the app's id for this host.");
  const topic = typeof value.topic === "string" ? value.topic : undefined;
  if (platform === "ios" && (!topic || !BUNDLE_ID.test(topic))) throw new HostCommandError("An iOS device names its app's bundle identifier as topic.");
  const relay = decodeRelay(value.relay);
  return { platform, token, host: value.host, ...(topic && platform === "ios" ? { topic } : {}), ...(relay ? { relay } : {}) };
}

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
      let apns: ApnsClient | undefined;
      let fcm: FcmClient | undefined;
      /** Why a saved key did not read; its platform stays on the direct route and fails visibly. */
      let keyErrors: { apns?: string; fcm?: string } = {};
      const lastPushed = new Map<string, number>();

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
        return route === "relay" && !device.relay ? "unreachable" : route;
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
        const payload = sealPush(relay, { title: note.title, body: note.body, ...(url ? { url } : {}), ...(note.kind ? { kind: note.kind } : {}), ...(tag ? { tag } : {}) });
        return sendThroughRelay(relayUrl, { handle: relay.handle, payload, ...(tag ? { collapseId: tag } : {}) }, options.fetch);
      };

      const sendOne = async (device: StoredDevice, note: Note): Promise<SendOutcome> => {
        const url = note.threadId ? threadLink(device.host, note.threadId) : undefined;
        if (routeFor(device.platform) === "relay") {
          if (!device.relay) return { ok: false, gone: false, status: 0, reason: "This phone's Tau app is too old for Tau's relay; update it, or save a key of your own." };
          return sendRelayed(device.relay, note, url);
        }
        if (device.platform === "android") {
          if (!fcm) return { ok: false, gone: false, status: 0, reason: keyErrors.fcm ? `The saved Firebase service account does not read: ${keyErrors.fcm}` : "No Firebase service account is set up on this host." };
          return fcm.send(device.token, {
            notification: { title: note.title, body: note.body },
            data: { ...(url ? { url } : {}), ...(note.kind ? { kind: note.kind } : {}) },
            android: {
              priority: "HIGH",
              ...(note.threadId ? { collapse_key: collapseId(note.threadId) } : {}),
              notification: { ...(note.threadId ? { tag: collapseId(note.threadId) } : {}) },
            },
          });
        }
        if (!apns) return { ok: false, gone: false, status: 0, reason: keyErrors.apns ? `The saved APNs key does not read: ${keyErrors.apns}` : "No APNs key is set up on this host." };
        const request = {
          token: device.token,
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

      /** Someone at a focused client sees it there; without Notifications Kit nobody can say, so the phone hears. */
      const attended = async (): Promise<boolean> => {
        try {
          const answer = await context.invokeHostExtension(NOTIFICATIONS_EXTENSION_ID, ATTENDED_COMMAND);
          return (answer as { attended?: unknown } | undefined)?.attended === true;
        } catch {
          return false;
        }
      };

      const raise = async (threadId: string, kind: PushKind, text?: string): Promise<void> => {
        if (!threadId) return;
        const thread = services.thread(threadId);
        // A sub-agent reports to the thread that spawned it, not to the user.
        if (thread?.parentThreadId) return;
        const targets = reachable();
        if (targets.length === 0) return;
        if (await attended()) return;
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
      const raiseLater = (threadId: string, kind: PushKind, text?: string) => {
        const work = raise(threadId, kind, text).catch((error: unknown) => services.log("push.failed", errorText(error)));
        options.track?.(work);
      };

      const stops = [
        services.registerTurnObserver({
          ended: async (sessionId, _turnId, outcome) => raiseLater(sessionId, outcome === "failed" ? "failed" : "completed"),
        }),
        services.decorateUiPrompt((prompt) => {
          const approval = prompt.kind === "confirm" || (prompt.kind === "select" && prompt.options?.some((option) => APPROVAL_OPTION.test(option)));
          raiseLater(prompt.sessionId, approval ? "approval" : "question", questionText(prompt));
        }),
        services.registerThreadLifecycle({ threadDeleted: async (sessionId) => { lastPushed.delete(sessionId); } }),
        services.clients.observe({
          devicesChanged: () => {
            // Started before handing it over: `track?.(prune())` would skip the prune without a tracker.
            const work = prune().catch((error: unknown) => services.log("push.store", errorText(error)));
            options.track?.(work);
          },
        }),
      ];

      context.registerCommand("register", async (input, call) => {
        if (!call?.device) throw new HostCommandError("Only a paired device can receive push notifications from this host.");
        const registration = decodeRegistration(input);
        await store.upsert({ id: call.device, ...registration, registeredAt: new Date(now()).toISOString() });
        const route = routeFor(registration.platform);
        services.log("push.registered", `${registration.platform} ${call.device} ${route}`);
        publish();
        return { registered: true, ready: route === "direct" || Boolean(registration.relay), route };
      });
      context.registerCommand("unregister", async (_input, call) => {
        if (!call?.device) return false;
        const device = call.device;
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
        connect();
        publish();
        return status();
      });
      context.registerCommand("remove-device", async (input, call) => {
        ownerOnly(call);
        const id = (input as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string") throw new HostCommandError("remove-device takes { id }.");
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
        apns?.close();
      };
    },
  };
}

export default createPushHostExtension;
