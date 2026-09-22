import { describe, expect, it, vi } from "vitest";
import {
  candidateServers,
  parseLsofCwds,
  parseLsofListeners,
  parseNetstatListeners,
  scanPorts,
  splitAddress,
  type ProbeResult,
} from "./ports.js";

/** `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` as macOS prints it. */
const LSOF = [
  "p570", "crapportd", "f15", "n*:49232", "f16", "n*:49232",
  "p1098", "cControlCenter", "f9", "n*:7000", "f11", "n*:5000",
  "p4242", "cPython", "f3", "n*:8000",
  "p4300", "cnode", "f21", "n127.0.0.1:5173", "f22", "n[::1]:5173",
  "p4400", "cpostgres", "f7", "n127.0.0.1:5432",
  "p4500", "cnode", "f8", "n192.168.1.20:3000",
  "p999", "cElectron", "f40", "n127.0.0.1:61025",
  "",
].join("\n");

const LSOF_CWD = ["p4242", "fcwd", "n/work/app", "p4300", "fcwd", "n/work/app/web", "p4400", "fcwd", "n/", "p1098", "fcwd", "n/"].join("\n");

const NETSTAT_MAC = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.3000         *.*                    LISTEN
tcp46      0      0  *.8000                 *.*                    LISTEN
tcp4       0      0  127.0.0.1.52011        127.0.0.1.3000         ESTABLISHED
udp4       0      0  *.5353                 *.*`;

const NETSTAT_LINUX = `Active Internet connections (servers and established)
Proto Recv-Q Send-Q Local Address           Foreign Address         State
tcp        0      0 0.0.0.0:8080            0.0.0.0:*               LISTEN
tcp6       0      0 :::4200                 :::*                    LISTEN
tcp        0      0 10.0.0.5:22             10.0.0.9:51234          ESTABLISHED`;

const NETSTAT_WINDOWS = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       7788
  TCP    [::]:3000              [::]:0                 LISTENING       6644
  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     7788`;

describe("listener parsers", () => {
  it("splits every address spelling the tools use", () => {
    expect(splitAddress("*:8000")).toEqual({ host: "*", port: 8000 });
    expect(splitAddress("[::1]:5173")).toEqual({ host: "::1", port: 5173 });
    expect(splitAddress("127.0.0.1.3000")).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(splitAddress("*.8000")).toEqual({ host: "*", port: 8000 });
    expect(splitAddress(":::4200")).toEqual({ host: "::", port: 4200 });
    expect(splitAddress("fe80::1%lo0.8000")).toEqual({ host: "fe80::1", port: 8000 });
    expect(splitAddress("*:*")).toBeUndefined();
    expect(splitAddress("*:99999")).toBeUndefined();
  });

  it("reads lsof's field output, one socket per process and port", () => {
    const sockets = parseLsofListeners(LSOF);
    expect(sockets).toContainEqual({ pid: 4242, command: "Python", host: "*", port: 8000 });
    expect(sockets.filter((socket) => socket.pid === 4300)).toEqual([{ pid: 4300, command: "node", host: "127.0.0.1", port: 5173 }]);
    expect(sockets.filter((socket) => socket.pid === 570)).toHaveLength(1);
    expect(parseLsofCwds(LSOF_CWD)).toEqual(new Map([[4242, "/work/app"], [4300, "/work/app/web"], [4400, "/"], [1098, "/"]]));
  });

  it("reads netstat on macOS, Linux and Windows, listeners only", () => {
    expect(parseNetstatListeners(NETSTAT_MAC)).toEqual([{ host: "127.0.0.1", port: 3000 }, { host: "*", port: 8000 }]);
    expect(parseNetstatListeners(NETSTAT_LINUX)).toEqual([{ host: "0.0.0.0", port: 8080 }, { host: "::", port: 4200 }]);
    expect(parseNetstatListeners(NETSTAT_WINDOWS)).toEqual([
      { pid: 1012, host: "0.0.0.0", port: 135 },
      { pid: 7788, host: "127.0.0.1", port: 5173 },
      { pid: 6644, host: "::", port: 3000 },
    ]);
  });
});

describe("which listeners are dev servers", () => {
  it("keeps the workspace's own, dev ports and dev programs; drops Tau, remote interfaces and the rest", () => {
    const servers = candidateServers(parseLsofListeners(LSOF), { cwds: parseLsofCwds(LSOF_CWD), workspaceRoot: "/work/app", ownPids: new Set([999]) });
    expect(servers.map((server) => [server.port, server.command, server.inWorkspace])).toEqual([
      // ControlCenter holds 5000, a dev port: the probe decides about it.
      [5000, "ControlCenter", false],
      [8000, "Python", true],
      [5173, "node", true],
    ]);
    expect(servers.find((server) => server.port === 8000)?.url).toBe("http://localhost:8000/");
  });
});

describe("port scan", () => {
  const probeBy = (answers: Record<number, ProbeResult>) => async (url: string): Promise<ProbeResult> =>
    answers[Number(new URL(url).port)] ?? "none";

  it("asks lsof, then keeps what answers with a page, workspace servers first", async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => args.includes("cwd") ? LSOF_CWD : LSOF);
    const servers = await scanPorts({
      workspaceRoot: "/work/app",
      platform: "darwin",
      ownPids: new Set([999]),
      findCommand: (name) => name === "lsof" ? "/usr/sbin/lsof" : undefined,
      run,
      probe: probeBy({ 5000: "http", 8000: "html", 5173: "html" }),
    });
    expect(servers.map((server) => server.port)).toEqual([5173, 8000]);
    expect(servers.every((server) => server.html && server.inWorkspace)).toBe(true);
    expect(run.mock.calls[0]).toEqual(["/usr/sbin/lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"]]);
    expect(run.mock.calls[1]![1]).toEqual(["-a", "-d", "cwd", "-p", "570,1098,4242,4300,4400,4500", "-F", "pn"]);
  });

  it("falls back to netstat, and on Windows asks for PIDs", async () => {
    const run = vi.fn(async () => NETSTAT_WINDOWS);
    const servers = await scanPorts({
      workspaceRoot: "C:\\work",
      platform: "win32",
      ownPids: new Set(),
      findCommand: (name) => name === "netstat" ? "C:\\Windows\\System32\\netstat.exe" : undefined,
      run,
      probe: probeBy({ 5173: "html", 3000: "http" }),
    });
    expect(run).toHaveBeenCalledWith("C:\\Windows\\System32\\netstat.exe", ["-ano", "-p", "TCP"]);
    expect(servers.map((server) => [server.port, server.pid])).toEqual([[5173, 7788]]);
  });

  it("finds nothing without a tool to ask", async () => {
    const run = vi.fn(async () => "");
    await expect(scanPorts({ workspaceRoot: "/w", platform: "linux", ownPids: new Set(), findCommand: () => undefined, run, probe: async () => "html" })).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
