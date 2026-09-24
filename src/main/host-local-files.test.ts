import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { HOST_CAPABILITY } from "../shared/host-transport.js";
import { isLocalPeer, isLoopbackPeer, peerAddress, proxyUser, socketCapabilities } from "./host-local-files.js";

const base = [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay];

const request = (remoteAddress: string, forwarded?: string | string[]) =>
  ({ socket: { remoteAddress }, headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded } }) as unknown as IncomingMessage;

describe("local files over a socket", () => {
  it("recognizes loopback peers, including IPv4-mapped ones", () => {
    expect(isLoopbackPeer("127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("::1")).toBe(true);
    expect(isLoopbackPeer("10.0.0.4")).toBe(false);
    expect(isLoopbackPeer(undefined)).toBe(false);
  });

  it("announces local files only for a loopback peer the operator opted in for", () => {
    expect(socketCapabilities(base, "127.0.0.1", { TAU_HOST_LOCAL_FILES: "1" })).toContain(HOST_CAPABILITY.localFiles);
    expect(socketCapabilities(base, "127.0.0.1", {})).not.toContain(HOST_CAPABILITY.localFiles);
    expect(socketCapabilities(base, "192.168.1.9", { TAU_HOST_LOCAL_FILES: "1" })).not.toContain(HOST_CAPABILITY.localFiles);
    expect(socketCapabilities(base, "127.0.0.1", {})).toEqual(base);
  });

  it.each(["proxy", "network"] as const)("never announces local files on a %s listener, even to 127.0.0.1", (trust) => {
    expect(socketCapabilities(base, "127.0.0.1", { TAU_HOST_LOCAL_FILES: "1" }, trust)).toEqual(base);
    expect(isLocalPeer(trust, "127.0.0.1")).toBe(false);
  });
});

describe("the address of a peer", () => {
  it("is the socket's own address outside a proxy, whatever the client forwards", () => {
    expect(peerAddress("loopback", request("127.0.0.1", "100.64.0.9"))).toBe("127.0.0.1");
    expect(peerAddress("network", request("192.168.1.9", "100.64.0.9"))).toBe("192.168.1.9");
  });

  it("is the hop the proxy added behind one, not what the client claimed before it", () => {
    expect(peerAddress("proxy", request("127.0.0.1", "10.9.9.9, 100.101.102.103"))).toBe("100.101.102.103");
    expect(peerAddress("proxy", request("127.0.0.1", ["10.9.9.9", "fd7a:115c:a1e0::5"]))).toBe("fd7a:115c:a1e0::5");
  });

  it("falls back to the socket when the proxy forwarded nothing usable", () => {
    expect(peerAddress("proxy", request("127.0.0.1"))).toBe("127.0.0.1");
    expect(peerAddress("proxy", request("127.0.0.1", "not-an-address"))).toBe("127.0.0.1");
  });
});

describe("the user a proxy names", () => {
  const named = (login: string | string[]) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { "tailscale-user-login": login } }) as unknown as IncomingMessage;

  it("is read behind the proxy listener only, where Serve set it and dropped what the client sent", () => {
    expect(proxyUser("proxy", named("alice@example.com"))).toBe("alice@example.com");
    expect(proxyUser("network", named("alice@example.com"))).toBeUndefined();
    expect(proxyUser("loopback", named("alice@example.com"))).toBeUndefined();
  });

  it("decodes the Q-encoded form Serve sends a name outside ASCII in, and drops control characters", () => {
    expect(proxyUser("proxy", named("=?utf-8?q?j=C3=BCrgen@example.com?="))).toBe("jürgen@example.com");
    expect(proxyUser("proxy", named("eve\u0007@example.com"))).toBe("eve@example.com");
    expect(proxyUser("proxy", named(""))).toBeUndefined();
  });
});
