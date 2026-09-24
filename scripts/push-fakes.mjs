#!/usr/bin/env node
// Loopback stand-ins for Apple's and Google's push services, for a test instance:
//
//   npm run build && node scripts/push-fakes.mjs [--out <dir>]
//
// writes a throwaway APNs key (`apns-key.p8`) and service account
// (`service-account.json`) into <dir> (default .tau-dev/push-fakes), prints the
// environment a test host needs (TAU_PUSH_APNS_ORIGIN, TAU_PUSH_FCM_ORIGIN) and
// appends every push it receives to <dir>/pushes.jsonl. Nothing reaches Apple or
// Google, and no key of the user's is read.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fakes = await import(pathToFileURL(join(ROOT, "dist-electron", "main", "test-support", "push-fakes.js")).href);
const at = process.argv.indexOf("--out");
const out = resolve(at > 0 ? process.argv[at + 1] : join(ROOT, ".tau-dev", "push-fakes"));
mkdirSync(out, { recursive: true });
const log = join(out, "pushes.jsonl");
const record = (service) => (request) => {
  if (request.path === "/token") return;
  appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), service, path: request.path, topic: request.headers["apns-topic"], body: JSON.parse(request.body || "{}") })}\n`);
  console.log(`[${service}] ${request.path}`);
};
const apns = await fakes.startFakeApns(undefined, record("apns"));
const fcm = await fakes.startFakeFcm(undefined, record("fcm"));
writeFileSync(join(out, "apns-key.p8"), fakes.throwawayApnsKey().pem, { mode: 0o600 });
writeFileSync(join(out, "service-account.json"), fakes.throwawayServiceAccount(fcm.tokenUri).json, { mode: 0o600 });
console.log(`TAU_PUSH_APNS_ORIGIN=${apns.origin}`);
console.log(`TAU_PUSH_FCM_ORIGIN=${fcm.origin}`);
console.log(`keys: ${out} (Key ID ${fakes.FAKE_KEY_ID}, Team ID ${fakes.FAKE_TEAM_ID}); pushes: ${log}`);
