import { describe, expect, it, vi } from "vitest";
import type { SavedHost } from "./hosts";
import { createPushRegistrar, tapRoute, type PushPort } from "./push";

const HOST: SavedHost = { id: "host-1", name: "Mac mini", endpoints: [], access: "full", addedAt: "2026-09-24T10:00:00.000Z" };

function port(overrides: Partial<PushPort> = {}): PushPort & { token: ReturnType<typeof vi.fn> } {
  return {
    platform: "ios",
    available: async () => true,
    permission: async () => "prompt",
    requestPermission: vi.fn(async () => "granted" as const),
    token: vi.fn(async () => "ab".repeat(32)),
    topic: async () => "de.tbuck.tau",
    onTap: () => () => undefined,
    ...overrides,
  } as PushPort & { token: ReturnType<typeof vi.fn> };
}

describe("push registration", () => {
  it("asks the platform for the token once and hands it, with its own id for the host, to each host's Push Kit", async () => {
    const platform = port();
    const invokeHostExtension = vi.fn(async () => ({ registered: true }));
    const registrar = createPushRegistrar(platform);
    await expect(registrar.register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "registered" });
    await registrar.register({ host: { ...HOST, id: "host-2" }, client: { invokeHostExtension } });
    expect(platform.requestPermission).toHaveBeenCalledTimes(2);
    expect(platform.token).toHaveBeenCalledTimes(1);
    expect(invokeHostExtension.mock.calls).toEqual([
      ["tau.push", "register", { platform: "ios", token: "ab".repeat(32), host: "host-1", topic: "de.tbuck.tau" }],
      ["tau.push", "register", { platform: "ios", token: "ab".repeat(32), host: "host-2", topic: "de.tbuck.tau" }],
    ]);
  });

  it("does nothing without permission or without a Firebase project in an Android build", async () => {
    const invokeHostExtension = vi.fn();
    await expect(createPushRegistrar(port({ permission: async () => "denied" })).register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "denied" });
    await expect(createPushRegistrar(port({ platform: "android", available: async () => false })).register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "unavailable" });
    expect(invokeHostExtension).not.toHaveBeenCalled();
  });

  it("carries on when the host will not take the token", async () => {
    const invokeHostExtension = vi.fn(async () => { throw new Error("Host extension tau.push is not installed."); });
    await expect(createPushRegistrar(port({ permission: async () => "granted" })).register({ host: HOST, client: { invokeHostExtension } }))
      .resolves.toEqual({ state: "refused", detail: "Host extension tau.push is not installed." });
  });

  it("asks the platform for a token again after it failed once", async () => {
    const token = vi.fn().mockRejectedValueOnce(new Error("no network")).mockResolvedValue("cd".repeat(32));
    const registrar = createPushRegistrar(port({ permission: async () => "granted", token }));
    const invokeHostExtension = vi.fn(async () => undefined);
    await expect(registrar.register({ host: HOST, client: { invokeHostExtension } })).rejects.toThrow("no network");
    await expect(registrar.register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "registered" });
  });

  it("opens the thread a tapped notification names, and nothing for anything else", () => {
    expect(tapRoute({ url: "tau://thread?host=host-1&thread=t1", kind: "completed" })).toEqual({ view: "workbench", hostId: "host-1", threadId: "t1" });
    expect(tapRoute({ url: "https://example.com" })).toBeUndefined();
    expect(tapRoute({})).toBeUndefined();
  });
});
