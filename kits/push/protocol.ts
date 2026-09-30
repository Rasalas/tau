// Shared by both halves and by the app; no imports, so any side may read it.

export const PUSH_EXTENSION_ID = "tau.push";

/** Pushed without a payload whenever keys or devices change; Settings asks for `status` again. */
export const PUSH_STATE_EVENT = "state";

/** Notifications Kit's command this kit asks, copied rather than imported (a kit never imports another kit). */
export const NOTIFICATIONS_EXTENSION_ID = "tau.notifications";
export const ATTENDED_COMMAND = "attended";

export type PushPlatform = "ios" | "android";

/** What happened: a turn ended or failed, an agent hands over ("your turn"), a thread asks. */
export type PushKind = "completed" | "failed" | "turn" | "question" | "approval";

/** Setting `values.tau.push.content`: the thread's title alone, or with what the agent said. */
export type PushContent = "title" | "excerpt";
export const PUSH_CONTENT_KEY = "content";
export const DEFAULT_PUSH_CONTENT: PushContent = "excerpt";

export function readPushContent(value: unknown): PushContent {
  return value === "title" ? "title" : DEFAULT_PUSH_CONTENT;
}

/** Tau's push relay (docs/push.md); a host sends through it for a platform it has no key of its own for. */
export const PUSH_RELAY_URL = "https://europe-west3-tau-push-e3c95.cloudfunctions.net/relay";

/** How pushes reach a platform: with this host's own key, or through Tau's relay. */
export type PushRoute = "direct" | "relay";

/** What the app hands a host for the relay: the relay's handle and a key only the phone and this host know. */
export interface PushRelayRegistration {
  /** The relay's sealed form of the push token; the relay alone opens it. */
  handle: string;
  /** Names the key in every sealed push, so the phone knows which one opens it. */
  keyId: string;
  /** 32 random bytes, base64url: AES-256-GCM over what a push says. */
  key: string;
}

/** What the app sends once a host's workbench is connected (`register`). */
export interface PushRegistration {
  platform: PushPlatform;
  /** An APNs device token (hex) or an FCM registration token. */
  token: string;
  /** The app's own id for this host, echoed in every notification so a tap opens the right one. */
  host: string;
  /** iOS: the app's bundle identifier, the APNs topic. */
  topic?: string;
  /** Absent from an app older than the relay, or one that could not reach it. */
  relay?: PushRelayRegistration;
}

/**
 * A sealed push, version 1: `1.<keyId>.<base64url(nonce ‖ ciphertext ‖ tag)>`,
 * AES-256-GCM with a random 96-bit nonce over the JSON of `SealedPushContent`,
 * the associated data `sealedPushAad(keyId)`. A new layout takes a new version.
 */
export const SEALED_PUSH_VERSION = 1;
export const sealedPushAad = (keyId: string) => `tau-push:${SEALED_PUSH_VERSION}:${keyId}`;

export interface SealedPushContent {
  title: string;
  body: string;
  /** The thread's `tau://thread?…` link. */
  url?: string;
  kind?: PushKind;
  /** Replaces the thread's earlier notification; the same opaque id the relay sees as collapse id. */
  tag?: string;
}

/** Another kit asks for a push about a thread (`notify`); Takeover does for "your turn". */
export interface PushNotifyInput {
  threadId: string;
  kind: PushKind;
  /** The agent's reason or question, shown unless the user chose titles only. */
  text?: string;
}

export interface PushDeviceRow {
  /** The paired device's id (Settings → Connections). */
  id: string;
  name: string;
  platform: PushPlatform;
  registeredAt: string;
  /** `unreachable`: no key for its platform here, and its app sent nothing for the relay. */
  route?: PushRoute | "unreachable";
  lastPush?: { at: string; ok: boolean; detail?: string };
}

/** What Settings shows. Never a key: only what identifies it. `error`: the saved key does not read, and nothing is sent for that platform. */
export interface PushStatus {
  apns?: { keyId: string; teamId: string; savedAt: string; error?: string };
  fcm?: { projectId: string; clientEmail: string; savedAt: string; error?: string };
  devices: PushDeviceRow[];
  /** Where the keys are kept, a file only this user may read. */
  file: string;
  /** Per platform: this host's own key when one is saved, even one that does not read, otherwise the relay. */
  routes?: Record<PushPlatform, PushRoute>;
}

export interface ApnsKeyInput {
  keyId: string;
  teamId: string;
  /** The `.p8` file's text. */
  key: string;
}

export interface FcmKeyInput {
  /** The service account file's JSON text, as Firebase downloads it. */
  serviceAccount: string;
}

/** The app's link for a thread: `tau://thread?host=<id>&thread=<id>` (mobile/src/routes.ts). */
export function threadLink(host: string, threadId: string): string {
  return `tau://thread?${new URLSearchParams({ host, thread: threadId }).toString()}`;
}

export function decodePushStatus(value: unknown): PushStatus | undefined {
  const status = value as Partial<PushStatus> | null;
  if (!status || typeof status !== "object" || !Array.isArray(status.devices) || typeof status.file !== "string") return undefined;
  return status as PushStatus;
}
