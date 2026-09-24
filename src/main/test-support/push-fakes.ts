// For tests and the smoke only: throwaway keys and loopback stand-ins for
// Apple's and Google's push services. Nothing here reaches either of them.
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import type { AddressInfo } from "node:net";

/** A key in the shape Apple hands out: PKCS#8 PEM of an EC P-256 key. */
export function throwawayApnsKey(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey };
}

/** A service account file of a project that does not exist, its token endpoint at `tokenUri`. */
export function throwawayServiceAccount(tokenUri: string): { json: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const json = JSON.stringify({
    type: "service_account",
    project_id: "tau-test-project",
    private_key_id: "0",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    client_email: "push@tau-test-project.iam.gserviceaccount.com",
    token_uri: tokenUri,
  });
  return { json, publicKey };
}

/** Checks a JWT's signature and answers its header and claims. */
export function readSignedJwt(jwt: string, publicKey: KeyObject, ec: boolean): { header: Record<string, unknown>; claims: Record<string, unknown> } | undefined {
  const [header, claims, signature] = jwt.split(".");
  if (!header || !claims || !signature) return undefined;
  const key = ec ? { key: publicKey, dsaEncoding: "ieee-p1363" as const } : publicKey;
  if (!verify("sha256", Buffer.from(`${header}.${claims}`), key, Buffer.from(signature, "base64url"))) return undefined;
  return { header: JSON.parse(Buffer.from(header, "base64url").toString()), claims: JSON.parse(Buffer.from(claims, "base64url").toString()) };
}

export interface FakeRequest { path: string; headers: Record<string, string>; body: string }

/** Apple's push service over cleartext HTTP/2 on loopback; `answer` decides each reply. */
export const FAKE_KEY_ID = "FAKEKEY123";
export const FAKE_TEAM_ID = "FAKETEAM12";

export async function startFakeApns(answer: (request: FakeRequest) => { status: number; reason?: string } = () => ({ status: 200 }), onRequest: (request: FakeRequest) => void = () => undefined) {
  const requests: FakeRequest[] = [];
  const server = createHttp2Server();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { body += chunk; });
    stream.on("end", () => {
      const request = { path: String(headers[":path"]), headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)])), body };
      requests.push(request);
      onRequest(request);
      const { status, reason } = answer(request);
      stream.respond({ ":status": status, "apns-id": `fake-${requests.length}` });
      stream.end(reason ? JSON.stringify({ reason }) : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Google's OAuth token endpoint and FCM's send endpoint on loopback HTTP/1.1. */
export async function startFakeFcm(answer: (request: FakeRequest) => { status: number; body?: unknown } = () => ({ status: 200, body: { name: "projects/tau-test-project/messages/1" } }), onRequest: (request: FakeRequest) => void = () => undefined) {
  const requests: FakeRequest[] = [];
  let issued = 0;
  const server = createHttpServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const seen = { path: request.url ?? "", headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])), body };
      requests.push(seen);
      onRequest(seen);
      const reply = seen.path === "/token"
        ? { status: 200, body: { access_token: `fake-access-${issued += 1}`, expires_in: 3600, token_type: "Bearer" } }
        : answer(seen);
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    requests,
    origin,
    tokenUri: `${origin}/token`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
