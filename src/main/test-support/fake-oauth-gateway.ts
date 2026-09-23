import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

/**
 * A local stand-in for an OAuth gateway, spoken the way Pi's Radius provider
 * speaks to one (`oauth: "radius"` in `models.json`): discovery, a consent
 * page that approves at once and redirects back, a device code approved by
 * visiting its page, tokens, and a model list. Nothing leaves 127.0.0.1.
 * `node src/main/test-support/fake-oauth-gateway.ts [port]` runs it alone.
 */
export interface FakeOAuthGateway {
  url: string;
  port: number;
  /** Paths asked, in order; token requests carry their grant type. */
  requests: string[];
  approveDevice(): void;
  close(): Promise<void>;
}

const USER_CODE = "FAKE-1234";
const AUTH_CODE = "fake-auth-code";

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function body(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    request.on("end", () => resolve(new URLSearchParams(text)));
  });
}

function tokens(): Record<string, unknown> {
  return { access_token: `fake-access-${Date.now()}`, refresh_token: "fake-refresh", expires_in: 3600, scope: "gateway offline_access" };
}

export async function startFakeOAuthGateway(options: { port?: number } = {}): Promise<FakeOAuthGateway> {
  let approved = false;
  const requests: string[] = [];
  let url = "";
  const server = createServer((request, response) => {
    void (async () => {
      const address = new URL(request.url ?? "/", url);
      if (address.pathname === "/v1/oauth/token") {
        const form = await body(request);
        const grant = form.get("grant_type") ?? "";
        requests.push(`${address.pathname} ${grant}`);
        if (grant === "authorization_code") return form.get("code") === AUTH_CODE ? json(response, 200, tokens()) : json(response, 400, { error: "invalid_grant" });
        if (grant === "refresh_token") return json(response, 200, tokens());
        if (grant.endsWith("device_code")) return approved ? json(response, 200, tokens()) : json(response, 400, { error: "authorization_pending" });
        return json(response, 400, { error: "unsupported_grant_type" });
      }
      requests.push(address.pathname);
      if (address.pathname === "/v1/oauth") return json(response, 200, { authorizationEndpoint: `${url}/authorize` });
      if (address.pathname === "/v1/oauth/device") {
        await body(request);
        return json(response, 200, { device_code: "fake-device", user_code: USER_CODE, verification_uri: `${url}/device`, expires_in: 600, interval: 1 });
      }
      if (address.pathname === "/v1/config") {
        return json(response, 200, {
          baseUrl: `${url}/v1`,
          models: [{ id: "fake-small", name: "Fake Small", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_000, maxTokens: 1_000 }],
        });
      }
      if (address.pathname === "/authorize") {
        const redirect = address.searchParams.get("redirect_uri");
        const state = address.searchParams.get("state") ?? "";
        if (!redirect) return json(response, 400, { error: "invalid_request" });
        response.writeHead(302, { location: `${redirect}?code=${AUTH_CODE}&state=${encodeURIComponent(state)}` });
        return response.end();
      }
      if (address.pathname === "/device") {
        approved = true;
        response.writeHead(200, { "content-type": "text/html" });
        return response.end("<p>Device approved. Return to Tau.</p>");
      }
      return json(response, 404, { error: "not_found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  url = `http://127.0.0.1:${port}`;
  return {
    url,
    port,
    requests,
    approveDevice: () => { approved = true; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startFakeOAuthGateway({ port: Number(process.argv[2] ?? 0) }).then((gateway) => {
    process.stdout.write(`fake-oauth-gateway ${gateway.url}\n`);
  });
}
