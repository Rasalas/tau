import { describe, expect, it } from "vitest";
import type { UiSession } from "./contracts.js";
import {
  addressPageUrl,
  decodeEnvironmentTarget,
  environmentRoute,
  environmentProjects,
  environmentStorageKey,
  environmentThreads,
  machineRoutes,
  orderEndpoints,
  refreshEndpoints,
  sameEndpoints,
  samePinnedKey,
  socketUrl,
} from "./environments.js";
import { decodeManagedRoute } from "./managed-connections.js";
import { decodeHostHelloReply, decodeHostServerFrame } from "./host-transport.js";

const session = (id: string, modifiedAt: number, extra: Partial<UiSession> = {}): UiSession => ({
  id, path: `/s/${id}.jsonl`, title: `Thread ${id}`, modifiedAt, projectPath: "/p", projectName: "p", messageCount: 1, ...extra,
});

describe("a machine's addresses", () => {
  it("refuses plaintext fallback for secure credentials, including stale saved endpoints", () => {
    const secure = { url: "https://studio.example/" };
    const plain = { url: "http://10.0.0.4:7788/", kind: "lan" as const };
    expect(orderEndpoints([plain, secure], plain.url)).toEqual([secure]);
    expect(orderEndpoints([plain], secure.url)).toEqual([]);
    expect(refreshEndpoints([secure], [plain], secure.url)).toEqual([secure]);
    expect(refreshEndpoints([plain, secure], [])).toEqual([secure]);
    expect(refreshEndpoints([plain], [plain], secure.url)).toEqual([]);
    expect(orderEndpoints([plain])).toEqual([plain]);
    expect(refreshEndpoints([plain], [plain], plain.url)).toEqual([plain]);
  });

  it("are tried nearest first, and the one that worked last before all", () => {
    const endpoints = [
      { url: "https://studio.tail.ts.net:7788/", kind: "magicdns" as const },
      { url: "https://192.168.1.4:7788/", kind: "lan" as const },
      { url: "https://100.64.1.2:7788/", kind: "tailscale" as const },
      { url: "https://studio.local:7788/", kind: "mdns" as const },
    ];
    expect(orderEndpoints(endpoints).map((endpoint) => endpoint.kind)).toEqual(["lan", "mdns", "tailscale", "magicdns"]);
    expect(orderEndpoints(endpoints, "https://100.64.1.2:7788/")[0]!.kind).toBe("tailscale");
  });

  it("follow the machine to new LAN addresses, keeping names, Tailscale, typed ones and the one that works", () => {
    const saved = [
      { url: "https://192.168.1.4:7788/", kind: "lan" as const },
      { url: "https://192.168.1.5:7788/", kind: "lan" as const },
      { url: "https://studio.local:7788/", kind: "mdns" as const },
      { url: "https://100.64.1.2:7788/", kind: "tailscale" as const },
      { url: "https://studio.example:7788/" },
    ];
    const fresh = [{ url: "https://10.0.0.8:7788/", kind: "lan" as const }, { url: "https://studio.local:7788/", kind: "mdns" as const }];
    expect(refreshEndpoints(saved, fresh, "https://192.168.1.5:7788/").map((endpoint) => endpoint.url)).toEqual([
      "https://10.0.0.8:7788/", "https://studio.local:7788/", "https://192.168.1.5:7788/", "https://100.64.1.2:7788/", "https://studio.example:7788/",
    ]);
    // A machine that names no address beyond loopback changes nothing.
    expect(refreshEndpoints(saved, [])).toEqual(saved);
  });

  it("keep the flag of an address a CA vouches for, from the hello and from what was saved", () => {
    const serve = { url: "https://studio.tail0000.ts.net/", kind: "magicdns" as const, trustedCertificate: true };
    const kept = { url: "https://old.tail0000.ts.net/", kind: "magicdns" as const, trustedCertificate: true };
    const refreshed = refreshEndpoints([{ url: "https://studio.tail0000.ts.net/", kind: "magicdns" }, kept], [serve]);
    expect(refreshed).toEqual([serve, kept]);
    expect(sameEndpoints([serve], [{ ...serve, trustedCertificate: undefined } as never])).toBe(false);
    // Over the wire only a DNS name outside .local may carry it.
    const reply = decodeHostHelloReply({ protocol: 1, hostVersion: "1", capabilities: [], resync: false, missed: [], nextSeq: 0, host: { id: "h", name: "n", endpoints: [
      serve, { url: "https://192.168.1.4:7788/", kind: "lan", trustedCertificate: true }, { url: "https://studio.local:7788/", kind: "mdns", trustedCertificate: true },
    ] } });
    expect(reply?.host?.endpoints).toEqual([serve, { url: "https://192.168.1.4:7788/", kind: "lan" }, { url: "https://studio.local:7788/", kind: "mdns" }]);
  });

  it("travel in a hello only as http(s) URLs of a known kind", () => {
    const reply = { protocol: 1, hostVersion: "1", capabilities: [], resync: false, missed: [], nextSeq: 0 };
    const frame = decodeHostServerFrame({
      type: "hello-reply", id: "h",
      reply: { ...reply, host: { id: "host-studio", name: "studio", endpoints: [{ url: "https://10.0.0.8:7788/", kind: "lan" }, { url: "file:///etc/passwd" }, { url: "https://x:1/", kind: "moon" }] } },
    });
    expect(frame).toMatchObject({ type: "hello-reply", reply: { host: { id: "host-studio", endpoints: [{ url: "https://10.0.0.8:7788/", kind: "lan" }, { url: "https://x:1/" }] } } });
  });

  it("have their socket on the page's own origin", () => {
    expect(socketUrl("https://studio.local:7788/#pair=abc")).toBe("wss://studio.local:7788/");
    expect(socketUrl("http://127.0.0.1:5000/")).toBe("ws://127.0.0.1:5000/");
  });

  it("can be typed by hand, with Tau's port when none is given", () => {
    expect(addressPageUrl("studio.local")).toBe("https://studio.local:7788/");
    expect(addressPageUrl("studio.local:9000")).toBe("https://studio.local:9000/");
    expect(addressPageUrl("wss://10.0.0.2:7788")).toBe("https://10.0.0.2:7788/");
    expect(addressPageUrl("http://127.0.0.1:4000/")).toBe("http://127.0.0.1:4000/");
    expect(addressPageUrl("not an address")).toBeUndefined();
    expect(addressPageUrl("ftp://studio")).toBeUndefined();
  });
});

describe("a machine's thread list", () => {
  it("is the user's own threads, newest first, capped, with the running ones marked", () => {
    const threads = environmentThreads({
      projects: [],
      sessions: [session("a", 1), session("b", 3), session("child", 4, { parentThreadId: "b" }), session("c", 2)],
    }, new Set(["c"]), 2);
    expect(threads.map((thread) => thread.id)).toEqual(["b", "c"]);
    expect(threads[1]).toMatchObject({ running: true, path: "/s/c.jsonl" });
    expect(threads[0]!.running).toBeUndefined();
  });

  it("carries what a rail row shows besides the title: branch, cost, runtime and model", () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0.5, turns: 1 };
    const [listed] = environmentThreads({ projects: [], sessions: [session("a", 1, { projectLabel: "feat/x", usage, backendKind: "codex", modelProvider: "openai", createdAt: 0 })] }, new Set());
    expect(listed).toMatchObject({ projectLabel: "feat/x", usage, backendKind: "codex", modelProvider: "openai", createdAt: 0 });
    expect(environmentThreads({ projects: [], sessions: [session("b", 1)] }, new Set())[0]).not.toHaveProperty("usage");
    // As in this machine's rail: a session nobody wrote in yet is no thread, unless it already runs.
    const drafts = environmentThreads({ projects: [], sessions: [session("empty", 1, { messageCount: 0 }), session("busy", 2, { messageCount: 0 })] }, new Set(["busy"]));
    expect(drafts.map((thread) => thread.id)).toEqual(["busy"]);
  });

  it("marks a thread whose runtime there still runs work that wakes it", () => {
    const task = { id: "t", kind: "monitor" as const, label: "CI" };
    const listed = environmentThreads({ projects: [], sessions: [
      session("held", 3, { background: [task] }),
      session("released", 2, { background: [{ ...task, blocksCompletion: false }] }),
      session("plain", 1),
    ] }, new Set());
    expect(listed.map((thread) => [thread.id, thread.background ?? false])).toEqual([["held", true], ["released", false], ["plain", false]]);
  });

  it("names its projects most recent first", () => {
    const projects = environmentProjects({
      sessions: [],
      projects: [{ path: "/a", name: "a", lastOpenedAt: 1 }, { path: "/b", name: "b", lastOpenedAt: 2, workspaceId: "ws-b" }],
    });
    expect(projects).toEqual([{ name: "b", lastOpenedAt: 2, workspaceId: "ws-b" }, { name: "a", lastOpenedAt: 1 }]);
  });

  it("does not advertise a proxy thread's project as a checkout on this machine", () => {
    const remote = { path: "/rex/api", workspaceId: "ws1_remote", name: "api", lastOpenedAt: 1 };
    const local = { path: "/mini/site", workspaceId: "ws1_local", name: "site", lastOpenedAt: 2 };
    expect(environmentProjects({ projects: [remote, local], sessions: [session("rex~s1", 1, { workspaceId: "ws1_remote", backendKind: "machine" })] })).toEqual([{ workspaceId: "ws1_local", name: "site", lastOpenedAt: 2 }]);
    expect(environmentProjects({ projects: [remote], sessions: [session("s1", 1, { workspaceId: "ws1_remote" })] })).toEqual([{ workspaceId: "ws1_remote", name: "api", lastOpenedAt: 1 }]);
  });

  it("carries project images as data for another device", () => {
    const icon = "data:image/svg+xml;base64,PHN2Zy8+";
    expect(environmentProjects({ sessions: [], projects: [{ path: "/remote/tau", name: "Tau", lastOpenedAt: 1, icon }] })[0]?.icon).toBe(icon);
  });
});

describe("client storage per machine", () => {
  const hostKeys = ["tau.bootstrap-cache.v7", "tau.composer-drafts.v1"];

  it("gives another machine its own copy of a host's keys and shares the rest", () => {
    expect(environmentStorageKey("tau.bootstrap-cache.v7", "studio", hostKeys)).toBe("tau.bootstrap-cache.v7@studio");
    expect(environmentStorageKey("tau.preferences.v1", "studio", hostKeys)).toBe("tau.preferences.v1");
    expect(environmentStorageKey("tau.bootstrap-cache.v7", undefined, hostKeys)).toBe("tau.bootstrap-cache.v7");
  });
});

describe("an arrival target", () => {
  it("is a thread by path or a new thread's draft, and nothing else", () => {
    expect(decodeEnvironmentTarget({ thread: { path: "/s/a.jsonl" } })).toEqual({ thread: { path: "/s/a.jsonl" } });
    expect(decodeEnvironmentTarget({ newThread: { draft: "hi", workspaceId: "ws" } })).toEqual({ newThread: { draft: "hi", workspaceId: "ws" } });
    expect(decodeEnvironmentTarget({ newThread: { draft: "hi", send: true, model: { provider: "p", id: "m" } } })).toEqual({ newThread: { draft: "hi", send: true, model: { provider: "p", id: "m" } } });
    // Nothing to send without a draft; a model needs both halves.
    expect(decodeEnvironmentTarget({ newThread: { draft: " ", send: true, model: { provider: "p" } } })).toEqual({ newThread: { draft: " " } });
    expect(decodeEnvironmentTarget({ thread: { path: 3 } })).toBeUndefined();
    expect(decodeEnvironmentTarget("x")).toBeUndefined();
  });
});

describe("environmentRoute", () => {
  it("names Tau's own route, and otherwise a saved machine's host names best first", () => {
    expect(environmentRoute({ managed: { ssh: { target: "me@studio" } }, endpoints: [{ url: "http://127.0.0.1:41000/" }] })).toEqual({ kind: "ssh", target: "me@studio" });
    expect(environmentRoute({ managed: { wsl: "Ubuntu" }, endpoints: [] })).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(environmentRoute({ managed: { connect: { relay: "https://relay.example", id: "x", token: "secret", port: 1 } }, endpoints: [] })).toEqual({ kind: "connect" });
    expect(environmentRoute({ endpoints: [
      { url: "https://127.0.0.1:7788/", kind: "loopback" },
      { url: "https://192.168.1.20:7788/", kind: "lan" },
      { url: "https://[fd7a:115c::5]:7788/", kind: "tailscale" },
      { url: "https://studio.tail1234.ts.net/", kind: "magicdns", trustedCertificate: true },
      { url: "https://studio.local:7788/", kind: "mdns" },
      { url: "not a url" },
    ] })).toEqual({ kind: "direct", hosts: ["studio.tail1234.ts.net", "studio.local", "fd7a:115c::5", "192.168.1.20", "127.0.0.1"] });
  });
});

describe("a machine's routes", () => {
  const connect = { relay: "https://relay.example", id: "0123abcd-0123-4567-89ab-0123456789ab", token: "A".repeat(43), port: 41000 };
  const lan = { url: "https://192.168.1.20:7788/", kind: "lan" as const };
  const bridge = { url: "https://127.0.0.1:41000/" };

  it("tells its own addresses from Tau Connect's bridge, and names those addresses as its route once it has some", () => {
    expect(machineRoutes({ managed: { connect }, endpoints: [lan, bridge] })).toEqual({ direct: [lan], connect: bridge });
    expect(machineRoutes({ managed: { connect }, endpoints: [] })).toEqual({ direct: [], connect: bridge });
    expect(machineRoutes({ endpoints: [lan, bridge] })).toEqual({ direct: [lan, bridge] });
    expect(environmentRoute({ managed: { connect }, endpoints: [bridge] })).toEqual({ kind: "connect" });
    expect(environmentRoute({ managed: { connect }, endpoints: [lan, bridge] })).toEqual({ kind: "direct", hosts: ["192.168.1.20"] });
  });

  it("joins two pairings only under the same pinned key", () => {
    const key = Array.from({ length: 32 }, () => "ef").join("");
    expect(samePinnedKey({ publicKey: key }, { publicKey: key.toUpperCase().match(/.{2}/gu)!.join(":") })).toBe(true);
    expect(samePinnedKey({ publicKey: key }, { publicKey: Array.from({ length: 32 }, () => "CD").join(":") })).toBe(false);
    // An old certificate pin proves nothing about the key.
    expect(samePinnedKey({}, { publicKey: key })).toBe(false);
  });

  it("keeps Tau Connect beside an SSH forward, and nothing beside a WSL distribution", () => {
    const ssh = { target: "me@studio", platform: "linux" as const, port: 4721 };
    expect(decodeManagedRoute({ ssh, connect })).toEqual({ ssh, connect });
    expect(decodeManagedRoute({ connect })).toEqual({ connect });
    expect(decodeManagedRoute({ ssh, connect: { ...connect, relay: "http://relay.example" } })).toEqual({ ssh });
    expect(decodeManagedRoute({ wsl: "Ubuntu" })).toEqual({ wsl: "Ubuntu" });
    expect(decodeManagedRoute({ connect: "nope" })).toBeUndefined();
  });
});
