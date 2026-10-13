import { describe, expect, it } from "vitest";
import { forwardedHost, hostAllowedOrigins, originAllowed as checkOrigin, type SocketOrigin } from "./host-origin.js";

const originAllowed = (request: SocketOrigin, allowed: readonly string[] = []) => checkOrigin({
  listenerAddress: "127.0.0.1", listenerPort: 7788, ...request,
}, allowed);

describe("socket origin check", () => {
  it("lets a client without an Origin header through: it is not a browser page", () => {
    expect(originAllowed({ host: "127.0.0.1:7788" })).toBe(true);
  });

  it("accepts the page this listener served, with or without its default port", () => {
    expect(originAllowed({ origin: "http://127.0.0.1:7788", host: "127.0.0.1:7788" })).toBe(true);
    expect(originAllowed({ origin: "https://Mac.tailnet.ts.net", host: "mac.tailnet.ts.net" }, ["https://mac.tailnet.ts.net"])).toBe(true);
    expect(originAllowed({ origin: "https://mac.local:7788", host: "mac.local:7788" }, ["https://mac.local:7788"])).toBe(true);
  });

  it("refuses a page on another site, another port, or an opaque origin", () => {
    expect(originAllowed({ origin: "https://evil.example", host: "127.0.0.1:7788" })).toBe(false);
    expect(originAllowed({ origin: "http://127.0.0.1:9999", host: "127.0.0.1:7788" })).toBe(false);
    expect(originAllowed({ origin: "null", host: "127.0.0.1:7788" })).toBe(false);
    expect(originAllowed({ origin: "http://127.0.0.1:7788" })).toBe(false);
  });

  it("refuses file origins even on loopback or when explicitly listed", () => {
    expect(originAllowed({ origin: "file://", host: "127.0.0.1:7788" })).toBe(false);
    expect(originAllowed({ origin: "file://", host: "127.0.0.1:7788" }, ["file://"])).toBe(false);
    expect(originAllowed({ origin: "file://machine/", host: "127.0.0.1:7788" }, ["file://machine/"])).toBe(false);
  });

  it("accepts what the operator allowed, a native shell's scheme included", () => {
    const allowed = ["capacitor://localhost", "http://localhost:5173/"];
    expect(originAllowed({ origin: "capacitor://localhost", host: "127.0.0.1:7788" }, allowed)).toBe(true);
    expect(originAllowed({ origin: "http://localhost:5173", host: "127.0.0.1:7788" }, allowed)).toBe(true);
    expect(originAllowed({ origin: "capacitor://elsewhere", host: "127.0.0.1:7788" }, allowed)).toBe(false);
  });

  it("accepts the host a proxy was reached at, as the proxy forwarded it", () => {
    expect(originAllowed({ origin: "https://mac.tailnet.ts.net", host: "127.0.0.1:7789", listenerPort: 7789, forwardedHost: "mac.tailnet.ts.net" })).toBe(true);
    expect(originAllowed({ origin: "https://mac.tailnet.ts.net:8443", host: "127.0.0.1:7789", listenerPort: 7789, forwardedHost: "Mac.tailnet.ts.net:8443" })).toBe(true);
    expect(originAllowed({ origin: "https://evil.example", host: "127.0.0.1:7789", listenerPort: 7789, forwardedHost: "mac.tailnet.ts.net" })).toBe(false);
    expect(forwardedHost("evil.example, mac.tailnet.ts.net")).toBe("mac.tailnet.ts.net");
    expect(forwardedHost(undefined)).toBeUndefined();
  });

  it("refuses a rebound Host even when the Origin matches or was allowed", () => {
    expect(originAllowed({ host: "evil.example:7788", origin: "http://evil.example:7788" })).toBe(false);
    expect(originAllowed({ host: "evil.example:7788" })).toBe(false);
    expect(originAllowed({ host: "evil.example:7788", origin: "http://localhost:5173" }, ["http://localhost:5173"])).toBe(false);
    expect(originAllowed({ host: "localhost:7789", origin: "http://localhost:7789" })).toBe(false);
    expect(originAllowed({})).toBe(false);
  });

  it("accepts loopback names and the actual listener address, including IPv6", () => {
    for (const host of ["localhost:7788", "127.0.0.1:7788", "[::1]:7788"]) {
      expect(originAllowed({ host, origin: `http://${host}` })).toBe(true);
    }
    expect(originAllowed({ host: "10.0.0.2:7788", origin: "https://10.0.0.2:7788", listenerAddress: "10.0.0.2" })).toBe(true);
    expect(originAllowed({ host: "10.0.0.3:7788", origin: "https://10.0.0.3:7788", listenerAddress: "10.0.0.2" })).toBe(false);
    expect(originAllowed({ host: "[fd00::2]:7788", origin: "https://[fd00::2]:7788", listenerAddress: "fd00::2" })).toBe(true);
    expect(originAllowed({ host: "127.0.0.1:7788", listenerAddress: "::ffff:127.0.0.1" })).toBe(true);
    expect(originAllowed({ host: "localhost", origin: "http://localhost", listenerPort: 80 })).toBe(true);
    expect(originAllowed({ host: "localhost", origin: "https://localhost", listenerPort: 443 })).toBe(true);
  });

  it("reads the allowed origins from the environment, the dev server's included", () => {
    expect(hostAllowedOrigins({ TAU_HOST_ALLOWED_ORIGINS: " capacitor://localhost, https://a.example ", TAU_DEV_SERVER_URL: "http://localhost:5173/?x=1" }))
      .toEqual(["capacitor://localhost", "https://a.example", "http://localhost:5173"]);
    expect(hostAllowedOrigins({})).toEqual([]);
  });
});
