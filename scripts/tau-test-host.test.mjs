import { describe, expect, it } from "vitest";
import { parseArgs, parseHostOutput, remoteWorkDir, testHostDir, testHostEnv, testWindowEnv } from "./tau-test-host.mjs";

describe("testHostEnv", () => {
  const base = { PATH: "/bin", HOME: "/Users/me", TAU_HOST_TLS: "1", TAU_HOST_URL: "wss://far", ELECTRON_RUN_AS_NODE: "1" };

  it("keeps everything under its own folder and on loopback", () => {
    const env = testHostEnv({ base, root: "/w", dir: "/w/.tau-dev/test-host" });
    expect(env.HOME).toBe("/w/.tau-dev/test-host/home");
    expect(env.USERPROFILE).toBe("/w/.tau-dev/test-host/home");
    for (const name of ["TAU_USER_DATA", "TAU_WORKSPACE", "TAU_HOST_TOKEN_FILE", "TAU_CONFIG_FILE", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "TAU_SERVICE_UNIT_DIR", "TAU_SERVERS_PROJECTS_ROOT"]) {
      expect(env[name].startsWith("/w/.tau-dev/test-host/")).toBe(true);
    }
    expect(env.TAU_HOST_LISTEN).toBe("127.0.0.1:0");
    expect(env.TAU_BONJOUR_SERVICE_TYPE).toBe("_tau-test._tcp");
    expect(env.TAU_SERVICE_CONTROL).toBe("/w/scripts/fake-service-manager.mjs");
    expect(env.TAU_NO_NATIVE_DIALOGS).toBe("1");
    expect(env.TAU_NO_RUNTIME_UPDATES).toBe("1");
    expect(env.TAU_SERVERS_LOOPBACK_ONLY).toBe("1");
    expect(env.PATH).toBe("/bin");
  });

  it("gives each named host its own folder, runtime homes and machine name", () => {
    const rex = testHostEnv({ base, root: "/w", dir: testHostDir("rex", "/w"), name: "rex" });
    const other = testHostEnv({ base: { ...base, CODEX_HOME: "/Users/me/.codex", TAU_MACHINE_NAME: "Mac" }, root: "/w", dir: testHostDir("mini", "/w") });
    expect(rex.TAU_USER_DATA).toBe("/w/.tau-dev/test-host-rex/userdata");
    expect(rex.TAU_HOST_TOKEN_FILE).toBe("/w/.tau-dev/test-host-rex/host-token");
    expect(rex.CODEX_HOME).toBe("/w/.tau-dev/test-host-rex/codex-home");
    expect(rex.TAU_MACHINE_NAME).toBe("rex");
    expect(other.CODEX_HOME).toBe("/w/.tau-dev/test-host-mini/codex-home");
    expect(other.TAU_MACHINE_NAME).toBeUndefined();
    expect(testHostEnv({ base, root: "/w", dir: testHostDir("smoke-rex", "/w"), name: "smoke-rex", machineName: "rex" }).TAU_MACHINE_NAME).toBe("rex");
    expect(rex.TAU_TEST_CLONE_ROOT).toBe(remoteWorkDir("/w"));
    expect(remoteWorkDir("/w")).toBe("/w/.tau-dev/remote-work");
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
    "tls fingerprint: SHA256 AA:BB (browsers show it; a renewal changes it)",
    "tls public key: SHA256 CC:DD (a client pins it as TAU_HOST_PUBLIC_KEY; a renewal keeps it)",
    "web client: https://127.0.0.1:58960/#pair=code&fp=AA (single use, 10 minutes; allow the device in Settings → Connections)",
    "tau-host proxy listener on http://127.0.0.1:58961",
  ].join("\n");

  it("reads the socket, fingerprint, key, proxy listener and link", () => {
    expect(parseHostOutput(printed, { proxy: true, tls: true })).toEqual({
      url: "wss://127.0.0.1:58960",
      fingerprint: "AA:BB",
      publicKey: "CC:DD",
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

describe("testHostDir and parseArgs", () => {
  it("keeps the unnamed host where it was and refuses names that leave .tau-dev", () => {
    expect(testHostDir(undefined, "/w")).toBe("/w/.tau-dev/test-host");
    expect(testHostDir("rex", "/w")).toBe("/w/.tau-dev/test-host-rex");
    for (const bad of ["", "../x", "Rex", "a/b", "-x", "x".repeat(33)]) expect(() => testHostDir(bad, "/w")).toThrow("test host name");
  });

  it("reads the flags and refuses unknown ones", () => {
    expect(parseArgs(["start", "--name", "rex", "--tls", "--kits", "--no-login"])).toEqual({
      command: "start",
      flags: { proxy: false, tls: true, kits: true, fresh: false, login: false, all: false, name: "rex" },
    });
    expect(parseArgs(["stop", "--all"]).flags.all).toBe(true);
    expect(() => parseArgs(["start", "--name"])).toThrow("--name needs a value");
    expect(() => parseArgs(["start", "--name", "../etc"])).toThrow("test host name");
    expect(() => parseArgs(["start", "--bind", "1"])).toThrow("unknown flag");
    expect(parseArgs(["start", "--name", "rex", "--port", "47001"]).flags.port).toBe(47001);
    for (const bad of ["1", "80", "70000", "x"]) expect(() => parseArgs(["start", "--port", bad])).toThrow("--port needs a port");
    expect(parseArgs(["start", "--name", "rex", "--cpus", "2"]).flags.cpus).toBe(2);
    for (const bad of ["0", "x", "1.5"]) expect(() => parseArgs(["start", "--cpus", bad])).toThrow("--cpus needs a count");
  });
});

describe("testWindowEnv", () => {
  it("makes the host's own window: its token and pinned key, its own userData, never focused, no listener of its own", () => {
    const dir = testHostDir("rex", "/w");
    const env = testWindowEnv({ base: { PATH: "/bin", TAU_MACHINE_NAME: "Mac" }, dir, state: { url: "wss://127.0.0.1:5000", publicKey: "AB:CD" } });
    expect(env.TAU_HOST_URL).toBe("wss://127.0.0.1:5000");
    expect(env.TAU_HOST_PUBLIC_KEY).toBe("AB:CD");
    expect(env.TAU_HOST_TOKEN_FILE).toBe(`${dir}/host-token`);
    expect(env.TAU_USER_DATA).toBe(`${dir}/window-userdata`);
    expect(env.HOME).toBe(`${dir}/home`);
    expect(env.TAU_NO_FOCUS).toBe("1");
    expect(env.TAU_NO_NATIVE_DIALOGS).toBe("1");
    for (const name of ["TAU_HOST_LISTEN", "TAU_NO_EXTENSIONS", "TAU_HOST_TLS", "TAU_MACHINE_NAME"]) expect(env[name]).toBeUndefined();
  });
});
