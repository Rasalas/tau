import { describe, expect, it } from "vitest";
import { HOST_CAPABILITY } from "../shared/host-transport.js";
import { isLoopbackPeer, socketCapabilities } from "./host-local-files.js";

const base = [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay];

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
});
