// The Cloud Function around the relay (docs/push.md). Everything it decides lives in relay.ts.
import { initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { ApnsClient } from "../../kits/push/apns.js";
import { parseKeyring } from "./handle.js";
import { createRelay, type RelayRequest, type RelayResponse, type Senders } from "./relay.js";
import { apnsSender, fcmSender } from "./senders.js";

export const REGION = "europe-west3";
/** The function's own identity: FCM Admin and access to the four secrets, nothing else. */
export const RUNTIME_SERVICE_ACCOUNT = "push-relay-runtime@tau-push-e3c95.iam.gserviceaccount.com";

const HANDLE_KEYS = defineSecret("RELAY_HANDLE_KEYS");
const APNS_KEY = defineSecret("APNS_KEY_P8");
const APNS_KEY_ID = defineSecret("APNS_KEY_ID");
const APNS_TEAM_ID = defineSecret("APNS_TEAM_ID");

let handler: ((request: RelayRequest) => Promise<RelayResponse>) | undefined;

/** Built on the first request: secrets are readable only then. */
function relayHandler(): (request: RelayRequest) => Promise<RelayResponse> {
  if (handler) return handler;
  initializeApp();
  const senders: Senders = { android: fcmSender(getMessaging()) };
  try {
    const credentials = { keyId: APNS_KEY_ID.value().trim().toUpperCase(), teamId: APNS_TEAM_ID.value().trim().toUpperCase(), key: APNS_KEY.value() };
    senders.ios = apnsSender(new ApnsClient({ credentials }));
  } catch {
    // Until the APNs key exists its secrets may hold a placeholder; iPhones then get 503.
    logger.warn("apns.unconfigured");
  }
  handler = createRelay({ keyring: parseKeyring(HANDLE_KEYS.value()), senders, log: (level, event, fields) => (level === "error" ? logger.error(event, fields) : logger.warn(event, fields)) });
  return handler;
}

export const relay = onRequest(
  {
    region: REGION,
    invoker: "public",
    serviceAccount: RUNTIME_SERVICE_ACCOUNT,
    secrets: [HANDLE_KEYS, APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID],
    // Small on purpose: a flood costs at most two instances of ten requests each.
    maxInstances: 2,
    concurrency: 10,
    cpu: 1,
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (request, response) => {
    let answer: RelayResponse;
    try {
      answer = await relayHandler()({ method: request.method, path: request.path, body: request.rawBody, headers: request.headers });
    } catch (error) {
      // A keyring that does not parse; the message names the entry, never a key.
      logger.error("relay.failed", { detail: error instanceof Error ? error.message : "unknown" });
      answer = { status: 503, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ error: "unavailable" }) };
    }
    response.status(answer.status).set(answer.headers).send(answer.body);
  },
);
