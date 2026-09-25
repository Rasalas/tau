import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tauServiceTxt } from "../shared/discovery.js";
import {
  LIFETIME_SCRIPT,
  ServiceAnnouncer,
  announceInvocation,
  browseInvocation,
  browseServices,
  discoverHosts,
  instanceName,
  machineDisplayName,
  parseAvahiBrowse,
  parseDnsSdZone,
  parseWindowsBrowse,
  unescapeDnsText,
  type DiscoveryProcess,
  type ServiceAnnouncement,
} from "./host-discovery.js";

const FP = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
const HOST_ID = "0123456789abcdef0123456789abcdef";
const TXT = tauServiceTxt({ hostId: HOST_ID, fingerprint: FP });
const SERVICE: ServiceAnnouncement = { type: "_tau-test._tcp", name: "Studio", port: 7788, txt: TXT };
const tools = (names: Record<string, string>) => (name: string) => names[name];

/** A process that ends when its stdin closes, as the lifetime wrapper does, unless told to linger. */
class FakeProcess extends EventEmitter implements DiscoveryProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly signals: string[] = [];
  exited = false;

  constructor(readonly command: string, readonly args: readonly string[], options: { linger?: boolean } = {}) {
    super();
    this.stdin.on("finish", () => { if (!options.linger) this.exit(0, null); });
  }

  say(text: string, stream: "stdout" | "stderr" = "stdout"): void {
    this[stream].write(`${text}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.exit(null, signal);
    return true;
  }
}

function fakeSpawner(options: { linger?: boolean } = {}) {
  const spawned: FakeProcess[] = [];
  return {
    spawned,
    spawn: (command: string, args: readonly string[]) => {
      const child = new FakeProcess(command, args, options);
      spawned.push(child);
      return child;
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

// Captured from `dns-sd -Z _tau-test._tcp local` on macOS 27 while a test service was up.
const DNS_SD_ZONE = `Browsing for _tau-test._tcp.local
DATE: ---Thu 24 Sep 2026---
12:45:03.990  ...STARTING...

; To direct clients to browse a different domain, substitute that domain in place of '@'
lb._dns-sd._udp                                 PTR     @

_tau-test._tcp                                  PTR     Tau\\032Test\\032F06._tau-test._tcp
Tau\\032Test\\032F06._tau-test._tcp               SRV     0 0 47999 Mac-mini-von-Alex.local. ; Replace with unicast FQDN of target host
Tau\\032Test\\032F06._tau-test._tcp               TXT     "v=1" "id=0123abcd" "fp=AB:CD"

_tau-test._tcp                                  PTR     Tau\\032Test\\032F06._tau-test._tcp
Tau\\032Test\\032F06._tau-test._tcp               SRV     0 0 47999 Mac-mini-von-Alex.local. ; Replace with unicast FQDN of target host
Tau\\032Test\\032F06._tau-test._tcp               TXT     "v=1" "id=0123abcd" "fp=AB:CD"
`;

const AVAHI = [
  "+;eth0;IPv6;Studio\\032\\040Tau\\041;_tau._tcp;local",
  "+;eth0;IPv4;Studio\\032\\040Tau\\041;_tau._tcp;local",
  `=;eth0;IPv6;Studio\\032\\040Tau\\041;_tau._tcp;local;studio.local;fe80::1;7788;"fp=${TXT.fp}" "id=${HOST_ID}" "v=1"`,
  `=;eth0;IPv4;Studio\\032\\040Tau\\041;_tau._tcp;local;studio.local;192.168.1.20;7788;"fp=${TXT.fp}" "id=${HOST_ID}" "v=1"`,
].join("\n");

describe("reading what the system tools print", () => {
  it("reads dns-sd -Z zone lines, once per instance, escapes resolved", () => {
    expect(parseDnsSdZone(DNS_SD_ZONE, "_tau-test._tcp")).toEqual([
      { name: "Tau Test F06", hostName: "Mac-mini-von-Alex.local", port: 47999, txt: { v: "1", id: "0123abcd", fp: "AB:CD" }, addresses: [] },
    ]);
  });

  it("reads avahi-browse's parsable lines with their addresses", () => {
    const services = parseAvahiBrowse(AVAHI);
    expect(services).toHaveLength(2);
    expect(services[1]).toEqual({ name: "Studio (Tau)", hostName: "studio.local", port: 7788, txt: TXT, addresses: ["192.168.1.20"] });
  });

  it("reads the Windows script's JSON lines and drops the service suffix", () => {
    const line = JSON.stringify({ name: "Studio._tau._tcp.local", hostName: "studio.local", port: 7788, addresses: ["192.168.1.20"], txt: { V: "1", id: HOST_ID, fp: TXT.fp } });
    expect(parseWindowsBrowse(`noise\n${line}\n`, "_tau._tcp")).toEqual([{ name: "Studio", hostName: "studio.local", port: 7788, txt: { v: "1", id: HOST_ID, fp: TXT.fp }, addresses: ["192.168.1.20"] }]);
  });

  it("decodes decimal escapes as UTF-8 bytes", () => {
    expect(unescapeDnsText("Caf\\195\\169\\032\\.x")).toBe("Café .x");
  });

  it("names the machine as people know it, never with a DHCP domain", () => {
    expect(machineDisplayName("darwin", () => "Mac mini von Alex\n", "Mini-von-Alex.fritz.box")).toBe("Mac mini von Alex");
    expect(machineDisplayName("darwin", () => "", "Mini-von-Alex.fritz.box")).toBe("Mini-von-Alex");
    expect(machineDisplayName("linux", () => { throw new Error("not run"); }, "studio.lan")).toBe("studio");
    expect(machineDisplayName("darwin", () => { throw new Error("not run"); }, "Mini.fritz.box", { TAU_MACHINE_NAME: " rex " })).toBe("rex");
  });

  it("keeps an instance name printable and within 63 bytes", () => {
    expect(instanceName("Mac-mini.local")).toBe("Mac-mini");
    expect(new TextEncoder().encode(instanceName("é".repeat(40))).length).toBeLessThanOrEqual(63);
    expect(instanceName("\u0000")).toBe("Tau");
  });
});

describe("the command each platform runs", () => {
  it("is dns-sd -R under the lifetime wrapper on macOS, each TXT entry its own argument", () => {
    const invocation = announceInvocation(SERVICE, { platform: "darwin", find: tools({ "dns-sd": "/usr/bin/dns-sd" }) });
    expect(invocation).toMatchObject({
      command: "/bin/sh",
      args: ["-c", LIFETIME_SCRIPT, "tau-discovery", "/usr/bin/dns-sd", "-R", "Studio", "_tau-test._tcp", "local.", "7788", "v=1", `id=${HOST_ID}`, `fp=${TXT.fp}`],
    });
    if ("unavailable" in invocation) throw new Error("expected a command");
    expect(invocation.ready("12:45:01.092  Got a reply for service Studio (2)._tau-test._tcp.local.: Name now registered and active")).toBe("Studio (2)");
    expect(invocation.ready("12:45:00.442  ...STARTING...")).toBeUndefined();
  });

  it("is avahi-publish on Linux, and says what to install when Avahi is missing", () => {
    const invocation = announceInvocation(SERVICE, { platform: "linux", find: tools({ "avahi-publish": "/usr/bin/avahi-publish" }) });
    expect(invocation).toMatchObject({ args: ["-c", LIFETIME_SCRIPT, "tau-discovery", "/usr/bin/avahi-publish", "-s", "Studio", "_tau-test._tcp", "7788", "v=1", `id=${HOST_ID}`, `fp=${TXT.fp}`] });
    if ("unavailable" in invocation) throw new Error("expected a command");
    expect(invocation.ready("Established under name 'Studio #2'")).toBe("Studio #2");
    expect(announceInvocation(SERVICE, { platform: "linux", find: tools({}) })).toEqual({ unavailable: expect.stringMatching(/avahi-utils/u) });
    expect(browseInvocation("_tau._tcp", 3000, { platform: "linux", find: tools({ "avahi-browse": "/usr/bin/avahi-browse" }) }))
      .toMatchObject({ args: ["-c", LIFETIME_SCRIPT, "tau-discovery", "/usr/bin/avahi-browse", "--parsable", "--resolve", "--terminate", "--no-db-lookup", "_tau._tcp"], stops: true });
  });

  it("is an encoded PowerShell script on Windows that names the full instance and reads stdin to withdraw", () => {
    const invocation = announceInvocation(SERVICE, { platform: "win32", find: tools({ "powershell.exe": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }) });
    if ("unavailable" in invocation) throw new Error("expected a command");
    expect(invocation.command).toMatch(/powershell\.exe$/u);
    const encoded = invocation.args.at(-1)!;
    expect(invocation.args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain(`"instance":"Studio._tau-test._tcp.local"`);
    expect(script).toContain("DnsServiceRegister");
    expect(script).toContain("[Console]::In.ReadLine()");
    // CreateProcess takes 32767 characters.
    expect(invocation.args.join(" ").length).toBeLessThan(30_000);
    expect(invocation.ready(JSON.stringify({ event: "announced", name: "Studio 2._tau-test._tcp.local" }))).toBe("Studio 2");
  });

  it("doubles a single quote in the name, so PowerShell reads it as one", () => {
    const invocation = announceInvocation({ ...SERVICE, name: "Alex's Mac" }, { platform: "win32", find: tools({ "powershell.exe": "powershell.exe" }) });
    if ("unavailable" in invocation) throw new Error("expected a command");
    expect(Buffer.from(invocation.args.at(-1)!, "base64").toString("utf16le")).toContain("Alex''s Mac._tau-test._tcp.local");
  });

  it("is nothing on a platform without a responder Tau knows", () => {
    expect(announceInvocation(SERVICE, { platform: "freebsd", find: tools({}) })).toEqual({ unavailable: expect.any(String) });
  });
});

describe("the announcer", () => {
  it("starts, reports the name the network settled on, and leaves a running announcement alone", async () => {
    const { spawn: fake, spawned } = fakeSpawner();
    const changes = vi.fn();
    const announcer = new ServiceAnnouncer({ platform: "darwin", find: tools({ "dns-sd": "/usr/bin/dns-sd" }), spawn: fake, onChange: changes });
    await announcer.set(SERVICE);
    expect(announcer.state()).toEqual({ state: "starting", name: "Studio", serviceType: "_tau-test._tcp" });
    spawned[0]!.say("12:45:01.092  Got a reply for service Studio (2)._tau-test._tcp.local.: Name now registered and active");
    await flush();
    expect(announcer.state()).toEqual({ state: "announced", name: "Studio (2)", serviceType: "_tau-test._tcp" });
    await announcer.set({ ...SERVICE });
    expect(spawned).toHaveLength(1);
    expect(changes).toHaveBeenCalled();
  });

  it("withdraws the old announcement before a new port or fingerprint goes up", async () => {
    const { spawn: fake, spawned } = fakeSpawner();
    const announcer = new ServiceAnnouncer({ platform: "darwin", find: tools({ "dns-sd": "/usr/bin/dns-sd" }), spawn: fake });
    await announcer.set(SERVICE);
    await announcer.set({ ...SERVICE, port: 7790 });
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.exited).toBe(true);
    expect(spawned[0]!.signals).toEqual([]);
    expect(spawned[1]!.args).toContain("7790");
  });

  it("stops by closing stdin and signals only a tool that does not end", async () => {
    vi.useFakeTimers();
    const { spawn: fake, spawned } = fakeSpawner({ linger: true });
    const announcer = new ServiceAnnouncer({ platform: "darwin", find: tools({ "dns-sd": "/usr/bin/dns-sd" }), spawn: fake, stopGraceMs: 2_000 });
    await announcer.set(SERVICE);
    const closing = announcer.close();
    await vi.advanceTimersByTimeAsync(2_000);
    await closing;
    expect(spawned[0]!.stdin.writableEnded).toBe(true);
    expect(spawned[0]!.signals).toEqual(["SIGTERM"]);
    expect(announcer.state()).toBeUndefined();
  });

  it("reports a tool that stopped and starts it again on the next set", async () => {
    const { spawn: fake, spawned } = fakeSpawner();
    const announcer = new ServiceAnnouncer({ platform: "linux", find: tools({ "avahi-publish": "/usr/bin/avahi-publish" }), spawn: fake });
    await announcer.set(SERVICE);
    spawned[0]!.say("Failed to create client object: Daemon not running", "stderr");
    await flush();
    spawned[0]!.exit(1, null);
    await flush();
    expect(announcer.state()).toMatchObject({ state: "failed", detail: "The announcement stopped: Failed to create client object: Daemon not running" });
    await announcer.set(SERVICE);
    expect(spawned).toHaveLength(2);
    expect(announcer.state()).toMatchObject({ state: "starting" });
  });

  it("says why nothing is announced where the system has no responder", async () => {
    const { spawn: fake, spawned } = fakeSpawner();
    const announcer = new ServiceAnnouncer({ platform: "linux", find: tools({}), spawn: fake });
    await announcer.set(SERVICE);
    expect(spawned).toHaveLength(0);
    expect(announcer.state()).toMatchObject({ state: "unavailable", detail: expect.stringMatching(/Avahi/u) });
  });

  it("refuses a service type that is not one", async () => {
    const announcer = new ServiceAnnouncer({ platform: "darwin", find: tools({ "dns-sd": "/usr/bin/dns-sd" }), spawn: fakeSpawner().spawn });
    await expect(announcer.set({ ...SERVICE, type: "_tau._tcp -x" })).rejects.toThrow(/service type/u);
  });
});

describe("looking for machines", () => {
  it("listens with dns-sd for the window, stops it, and looks up the .local name's addresses", async () => {
    vi.useFakeTimers();
    const { spawn: fake, spawned } = fakeSpawner();
    const lookup = vi.fn(async () => ["192.168.1.20"]);
    const zone = DNS_SD_ZONE.replaceAll("\"id=0123abcd\" \"fp=AB:CD\"", `"id=${HOST_ID}" "fp=${TXT.fp}"`);
    const looking = discoverHosts("_tau-test._tcp", { platform: "darwin", find: tools({ "dns-sd": "/usr/bin/dns-sd" }), spawn: fake, lookup, timeoutMs: 3_000, ownHostId: "someone-else-000" });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawned[0]!.args).toEqual(["-c", LIFETIME_SCRIPT, "tau-discovery", "/usr/bin/dns-sd", "-Z", "_tau-test._tcp", "local."]);
    spawned[0]!.stdout.write(zone);
    await vi.advanceTimersByTimeAsync(3_000);
    const { hosts, problem } = await looking;
    expect(problem).toBeUndefined();
    expect(spawned[0]!.stdin.writableEnded).toBe(true);
    expect(lookup).toHaveBeenCalledWith("Mac-mini-von-Alex.local");
    expect(hosts).toEqual([{
      name: "Tau Test F06", hostId: HOST_ID, fingerprint: FP, port: 47999, hostName: "Mac-mini-von-Alex.local", addresses: ["192.168.1.20"],
      endpoints: [{ url: "https://192.168.1.20:47999/", kind: "lan" }, { url: "https://mac-mini-von-alex.local:47999/", kind: "mdns" }],
    }]);
  });

  it("takes what avahi-browse printed once it ends by itself", async () => {
    const { spawn: fake, spawned } = fakeSpawner();
    const looking = browseServices("_tau._tcp", { platform: "linux", find: tools({ "avahi-browse": "/usr/bin/avahi-browse" }), spawn: fake });
    await flush();
    spawned[0]!.stdout.write(`${AVAHI}\n`);
    await flush();
    spawned[0]!.exit(0, null);
    const { services, problem } = await looking;
    expect(problem).toBeUndefined();
    expect(services.map((service) => service.addresses)).toEqual([["fe80::1"], ["192.168.1.20"]]);
  });

  it("reports why it could not look", async () => {
    const { spawn: fake, spawned } = fakeSpawner();
    const looking = browseServices("_tau._tcp", { platform: "linux", find: tools({ "avahi-browse": "/usr/bin/avahi-browse" }), spawn: fake });
    await flush();
    spawned[0]!.say("Failed to create client object: Daemon not running", "stderr");
    await flush();
    spawned[0]!.exit(1, null);
    expect(await looking).toEqual({ services: [], problem: "Failed to create client object: Daemon not running" });
    expect(await browseServices("_tau._tcp", { platform: "linux", find: tools({}), spawn: fake })).toEqual({ services: [], problem: expect.stringMatching(/avahi-utils/u) });
  });
});

describe.skipIf(process.platform === "win32")("the lifetime wrapper", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it("ends the tool once its stdin closes, which is also what a host that dies does", async () => {
    const wrapper = spawn("/bin/sh", ["-c", LIFETIME_SCRIPT, "tau-discovery", "/bin/sh", "-c", "echo $$; exec sleep 30"], { stdio: ["pipe", "pipe", "ignore"] });
    const pid = await new Promise<number>((resolve) => wrapper.stdout.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
    expect(alive(pid)).toBe(true);
    const exited = new Promise<number | null>((resolve) => wrapper.once("exit", (code) => resolve(code)));
    wrapper.stdin.destroy();
    await exited;
    expect(alive(pid)).toBe(false);
  });

  it("ends with the tool when the tool ends first", async () => {
    const wrapper = spawn("/bin/sh", ["-c", LIFETIME_SCRIPT, "tau-discovery", "/bin/sh", "-c", "exit 3"], { stdio: ["pipe", "ignore", "ignore"] });
    const code = await new Promise<number | null>((resolve) => wrapper.once("exit", (exitCode) => resolve(exitCode)));
    wrapper.stdin.end();
    expect(code).toBe(3);
  });
});
