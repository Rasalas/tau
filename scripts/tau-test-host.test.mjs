import { describe, expect, it } from "vitest";
import { parseHostOutput, testHostEnv } from "./tau-test-host.mjs";

describe("testHostEnv", () => {
  const base = { PATH: "/bin", HOME: "/Users/me", TAU_HOST_TLS: "1", TAU_HOST_URL: "wss://far", ELECTRON_RUN_AS_NODE: "1" };

  it("keeps everything under its own folder and on loopback", () => {
    const env = testHostEnv({ base, root: "/w", dir: "/w/.tau-dev/test-host" });
    expect(env.HOME).toBe("/w/.tau-dev/test-host/home");
    expect(env.USERPROFILE).toBe("/w/.tau-dev/test-host/home");
    for (const name of ["TAU_USER_DATA", "TAU_WORKSPACE", "TAU_HOST_TOKEN_FILE", "TAU_CONFIG_FILE", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "TAU_SERVICE_UNIT_DIR"]) {
      expect(env[name].startsWith("/w/.tau-dev/test-host/")).toBe(true);
    }
    expect(env.TAU_HOST_LISTEN).toBe("127.0.0.1:0");
    expect(env.TAU_BONJOUR_SERVICE_TYPE).toBe("_tau-test._tcp");
    expect(env.TAU_SERVICE_CONTROL).toBe("/w/scripts/fake-service-manager.mjs");
    expect(env.TAU_NO_NATIVE_DIALOGS).toBe("1");
    expect(env.PATH).toBe("/bin");
  });

  it("drops what the caller's shell set for another host", () => {
    const env = testHostEnv({ base, root: "/w", dir: "/d" });
    expect(env.TAU_HOST_TLS).toBeUndefined();
    expect(env.TAU_HOST_URL).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.TAU_HOST_PROXY_LISTEN).toBeUndefined();
  });

  it("adds the proxy listener on loopback, TLS, and kits only when asked", () => {
    const env = testHostEnv({ base: {}, root: "/w", dir: "/d", proxy: true, tls: true, kits: true, workspace: "/repo" });
    expect(env.TAU_HOST_PROXY_LISTEN).toBe("127.0.0.1:0");
    expect(env.TAU_HOST_TLS).toBe("1");
    expect(env.TAU_NO_EXTENSIONS).toBeUndefined();
    expect(env.TAU_WORKSPACE).toBe("/repo");
    expect(testHostEnv({ base: {}, root: "/w", dir: "/d" }).TAU_NO_EXTENSIONS).toBe("1");
  });
});

describe("parseHostOutput", () => {
  const printed = [
    "tau-host listening on wss://127.0.0.1:58960",
    "token: /d/host-token (copy it to the client machine, or pass it as TAU_HOST_TOKEN)",
    "tls fingerprint: SHA256 AA:BB (a client pins it as TAU_HOST_FINGERPRINT)",
    "web client: https://127.0.0.1:58960/#pair=code&fp=AA (single use, 10 minutes; allow the device in Settings → Connections)",
    "tau-host proxy listener on http://127.0.0.1:58961",
  ].join("\n");

  it("reads the socket, fingerprint, proxy listener and link", () => {
    expect(parseHostOutput(printed, { proxy: true, tls: true })).toEqual({
      url: "wss://127.0.0.1:58960",
      fingerprint: "AA:BB",
      proxyUrl: "http://127.0.0.1:58961",
      link: "https://127.0.0.1:58960/#pair=code&fp=AA",
    });
  });

  it("waits for the proxy listener when one was asked for", () => {
    expect(parseHostOutput(printed.split("\n").slice(0, 4).join("\n"), { proxy: true })).toBeUndefined();
    expect(parseHostOutput(printed.split("\n").slice(0, 4).join("\n"))).toMatchObject({ url: "wss://127.0.0.1:58960" });
  });

  it("is not ready before the host listens", () => {
    expect(parseHostOutput("tau-host starting")).toBeUndefined();
  });
});
