import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { deliveryPrompt, deliveryRetention, PAYLOAD_PROMPT_LIMIT, UNTIMED_RETENTION_MS, DELIVERY_WINDOW_MS, verifyWebhook, webhookSecretProblem, type WebhookRequest } from "./webhooks.js";

const NOW = Date.parse("2026-10-30T21:00:00Z");
const body = Buffer.from('{ "id": "evt_1",\n  "type": "invoice.paid" }');
const request = (headers: Record<string, string>, raw = body): WebhookRequest => ({ headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])), body: raw });
const hex = (secret: string, ...parts: (string | Buffer)[]) => { const mac = createHmac("sha256", secret); for (const part of parts) mac.update(part); return mac.digest("hex"); };

it("verifies Tau's own headers as before, timestamp and ID signed with the raw body", () => {
  const ts = String(NOW);
  const good = { "X-Tau-Delivery": "d1", "X-Tau-Timestamp": ts, "X-Tau-Signature": hex("k", `${ts}\nd1\n`, body) };
  expect(verifyWebhook(undefined, request(good), "k", NOW)).toMatchObject({ delivery: { id: "d1", timestamp: NOW, format: "tau" } });
  expect(verifyWebhook("tau", request(good), "other", NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("tau", request(good, Buffer.from("tampered")), "k", NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("tau", request(good), "k", NOW + DELIVERY_WINDOW_MS + 1)).toEqual({ status: 401 });
  expect(verifyWebhook("tau", request({ "X-Tau-Delivery": "d1", "X-Tau-Signature": good["X-Tau-Signature"] }), "k", NOW)).toEqual({ status: 400 });
});

it("verifies GitHub's X-Hub-Signature-256 over the exact bytes and names the event", () => {
  const good = { "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958", "X-GitHub-Event": "push", "X-Hub-Signature-256": `sha256=${hex("gh-secret", body)}` };
  expect(verifyWebhook("github", request(good), "gh-secret", NOW)).toMatchObject({ delivery: { id: good["X-GitHub-Delivery"], event: "push", timestamp: NOW, format: "github", replayKey: expect.stringMatching(/^sha256\.[A-Za-z0-9_-]{43}$/u) } });
  // Stored verifiers keep working for keys saved before the length rule: only new keys are held to it.
  expect(verifyWebhook("github", request(good), "wrong", NOW)).toEqual({ status: 401 });
  // Re-serialised JSON is different bytes, so it does not verify.
  expect(verifyWebhook("github", request(good, Buffer.from(JSON.stringify(JSON.parse(body.toString())))), "gh-secret", NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("github", request({ ...good, "X-Hub-Signature-256": hex("gh-secret", body) }), "gh-secret", NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("github", request({ ...good, "X-Hub-Signature-256": `sha256=${hex("gh-secret", body).toUpperCase()}` }), "gh-secret", NOW)).toEqual({ status: 401 });
  for (const missing of ["X-GitHub-Delivery", "X-GitHub-Event", "X-Hub-Signature-256"] as const) {
    const headers: Record<string, string> = { ...good };
    delete headers[missing];
    expect(verifyWebhook("github", request(headers), "gh-secret", NOW)).toEqual({ status: 400 });
  }
  expect(verifyWebhook("github", request({ ...good, "X-GitHub-Event": "ping" }), "gh-secret", NOW)).toEqual({ status: 200 });
  expect(verifyWebhook("github", request({ ...good, "X-GitHub-Event": "ping" }), "wrong", NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("github", request({ ...good, "X-GitHub-Delivery": "../../x" }), "gh-secret", NOW)).toEqual({ status: 400 });
});

it("verifies Stripe-Signature: any v1 may match, v0 is ignored, and the timestamp is held to five minutes", () => {
  const secret = "whsec_abc";
  const t = NOW / 1000;
  const v1 = hex(secret, `${t}.`, body);
  expect(verifyWebhook("stripe", request({ "Stripe-Signature": `t=${t},v1=${v1}` }), secret, NOW)).toMatchObject({ delivery: { id: "evt_1", event: "invoice.paid", timestamp: NOW, format: "stripe" } });
  expect(verifyWebhook("stripe", request({ "Stripe-Signature": `t=${t},v1=${hex("whsec_old", `${t}.`, body)},v1=${v1},v0=${"0".repeat(64)}` }), secret, NOW)).toHaveProperty("delivery");
  expect(verifyWebhook("stripe", request({ "Stripe-Signature": `t=${t},v1=${v1}` }), "whsec_other", NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("stripe", request({ "Stripe-Signature": `t=${t},v1=${v1}` }, Buffer.from(body.toString().replace("paid", "void"))), secret, NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("stripe", request({ "Stripe-Signature": `t=${t},v0=${hex(secret, `${t}.`, body)}` }), secret, NOW)).toEqual({ status: 400 });
  expect(verifyWebhook("stripe", request({ "Stripe-Signature": `t=${t},v1=${v1}` }), secret, NOW + 300_001)).toEqual({ status: 401 });
  expect(verifyWebhook("stripe", request({ "Stripe-Signature": `t=${t},v1=${v1}` }), secret, NOW - 300_001)).toEqual({ status: 401 });
  expect(verifyWebhook("stripe", request({ "Stripe-Signature": `t=${t + 1},v1=${v1}` }), secret, NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("stripe", request({ "Stripe-Signature": `v1=${v1}` }), secret, NOW)).toEqual({ status: 400 });
  expect(verifyWebhook("stripe", request({}), secret, NOW)).toEqual({ status: 400 });
  const noId = Buffer.from('{"type":"invoice.paid"}');
  expect(verifyWebhook("stripe", request({ "Stripe-Signature": `t=${t},v1=${hex(secret, `${t}.`, noId)}` }, noId), secret, NOW)).toEqual({ status: 400 });
});

it("compares a shared secret only when it is long enough and dedupes by Idempotency-Key", () => {
  const secret = "x".repeat(32);
  expect(verifyWebhook("bearer", request({ Authorization: `Bearer ${secret}`, "Idempotency-Key": "run-1" }), secret, NOW)).toMatchObject({ delivery: { id: "run-1", format: "bearer" } });
  expect(verifyWebhook("bearer", request({ Authorization: `Bearer ${secret}x` }), secret, NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("bearer", request({ Authorization: `Basic ${secret}` }), secret, NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("bearer", request({ Authorization: `BEARER ${secret}` }), secret, NOW)).toHaveProperty("delivery");
  expect(verifyWebhook("bearer", request({}), secret, NOW)).toEqual({ status: 401 });
  expect(verifyWebhook("bearer", request({ Authorization: "Bearer short" }), "short", NOW)).toEqual({ status: 401 });
  for (const format of ["bearer", "github", "tau", undefined] as const) {
    expect(webhookSecretProblem(format, "short")).toMatch(/32/u);
    expect(webhookSecretProblem(format, "k".repeat(32))).toBeUndefined();
  }
  expect(webhookSecretProblem("stripe", "abc")).toMatch(/whsec_/u);
  expect(webhookSecretProblem("stripe", "whsec_short")).toBeUndefined();
});

it("keeps untimed delivery IDs longer than signed-time ones", () => {
  expect(deliveryRetention("github")).toBe(UNTIMED_RETENTION_MS);
  expect(deliveryRetention("bearer")).toBe(UNTIMED_RETENTION_MS);
  expect(deliveryRetention("stripe")).toBe(DELIVERY_WINDOW_MS);
  expect(deliveryRetention(undefined)).toBe(DELIVERY_WINDOW_MS);
});

it("fences the payload with an unpredictable boundary and cuts it to its limit", () => {
  const delivery = { id: "d", timestamp: NOW, body: Buffer.from("a".repeat(PAYLOAD_PROMPT_LIMIT + 10)), format: "github" as const, event: "push" };
  const text = deliveryPrompt(delivery, true, "b0undary");
  expect(text).toContain(`cut to its first ${PAYLOAD_PROMPT_LIMIT} of ${PAYLOAD_PROMPT_LIMIT + 10} bytes`);
  expect(text).toContain("----- BEGIN WEBHOOK PAYLOAD b0undary -----\n");
  expect(text.endsWith("\n----- END WEBHOOK PAYLOAD b0undary -----")).toBe(true);
  expect(text.match(/a{100,}/u)![0]).toHaveLength(PAYLOAD_PROMPT_LIMIT);
  expect(deliveryPrompt(delivery, false)).toBe("\n\n[GitHub webhook delivery d, event push. The payload is not included.]");
  expect(deliveryPrompt(delivery, true)).not.toBe(deliveryPrompt(delivery, true));
});
