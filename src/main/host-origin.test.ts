import { describe, expect, it } from "vitest";
import { forwardedHost, hostAllowedOrigins, originAllowed } from "./host-origin.js";

describe("socket origin check", () => {
  it("lets a client without an Origin header through: it is not a browser page", () => {
    expect(originAllowed({ host: "127.0.0.1:7788", peerAddress: "192.168.1.20" })).toBe(true);
  });

  it("accepts the page this listener served, with or without its default port", () => {
    expect(originAllowed({ origin: "http://127.0.0.1:7788", host: "127.0.0.1:7788" })).toBe(true);
    expect(originAllowed({ origin: "https://Mac.tailnet.ts.net", host: "mac.tailnet.ts.net" })).toBe(true);
    expect(originAllowed({ origin: "https://mac.local:7788", host: "mac.local:7788" })).toBe(true);
  });

  it("refuses a page on another site, another port, or an opaque origin", () => {
    expect(originAllowed({ origin: "https://evil.example", host: "127.0.0.1:7788", peerAddress: "127.0.0.1" })).toBe(false);
    expect(originAllowed({ origin: "http://127.0.0.1:9999", host: "127.0.0.1:7788" })).toBe(false);
    expect(originAllowed({ origin: "null", host: "127.0.0.1:7788", peerAddress: "127.0.0.1" })).toBe(false);
    expect(originAllowed({ origin: "http://127.0.0.1:7788" })).toBe(false);
  });

  it("accepts Electron's file:// window only from this machine", () => {
    expect(originAllowed({ origin: "file://", host: "127.0.0.1:7788", peerAddress: "127.0.0.1" })).toBe(true);
    expect(originAllowed({ origin: "file://", host: "127.0.0.1:7788", peerAddress: "::ffff:127.0.0.1" })).toBe(true);
    expect(originAllowed({ origin: "file://", host: "10.0.0.2:7788", peerAddress: "10.0.0.9" })).toBe(false);
  });

  it("accepts what the operator allowed, a native shell's scheme included", () => {
    const allowed = ["capacitor://localhost", "http://localhost:5173/"];
    expect(originAllowed({ origin: "capacitor://localhost", host: "10.0.0.2:7788" }, allowed)).toBe(true);
    expect(originAllowed({ origin: "http://localhost:5173", host: "127.0.0.1:7788" }, allowed)).toBe(true);
    expect(originAllowed({ origin: "capacitor://elsewhere", host: "10.0.0.2:7788" }, allowed)).toBe(false);
  });

  it("accepts the host a proxy was reached at, as the proxy forwarded it", () => {
    expect(originAllowed({ origin: "https://mac.tailnet.ts.net", host: "127.0.0.1:7789", forwardedHost: "mac.tailnet.ts.net" })).toBe(true);
    expect(originAllowed({ origin: "https://mac.tailnet.ts.net:8443", host: "127.0.0.1:7789", forwardedHost: "Mac.tailnet.ts.net:8443" })).toBe(true);
    expect(originAllowed({ origin: "https://evil.example", host: "127.0.0.1:7789", forwardedHost: "mac.tailnet.ts.net" })).toBe(false);
    expect(forwardedHost("evil.example, mac.tailnet.ts.net")).toBe("mac.tailnet.ts.net");
    expect(forwardedHost(undefined)).toBeUndefined();
  });

  it("reads the allowed origins from the environment, the dev server's included", () => {
    expect(hostAllowedOrigins({ TAU_HOST_ALLOWED_ORIGINS: " capacitor://localhost, https://a.example ", TAU_DEV_SERVER_URL: "http://localhost:5173/?x=1" }))
      .toEqual(["capacitor://localhost", "https://a.example", "http://localhost:5173"]);
    expect(hostAllowedOrigins({})).toEqual([]);
  });
});
