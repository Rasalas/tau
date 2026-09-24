import { describe, expect, it } from "vitest";
import type { UiSession } from "./contracts.js";
import {
  addressPageUrl,
  decodeEnvironmentTarget,
  environmentProjects,
  environmentStorageKey,
  environmentThreads,
  orderEndpoints,
  refreshEndpoints,
  socketUrl,
} from "./environments.js";
import { decodeHostServerFrame } from "./host-transport.js";

const session = (id: string, modifiedAt: number, extra: Partial<UiSession> = {}): UiSession => ({
  id, path: `/s/${id}.jsonl`, title: `Thread ${id}`, modifiedAt, projectPath: "/p", projectName: "p", messageCount: 1, ...extra,
});

describe("a machine's addresses", () => {
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

  it("names its projects most recent first", () => {
    const projects = environmentProjects({
      sessions: [],
      projects: [{ path: "/a", name: "a", lastOpenedAt: 1 }, { path: "/b", name: "b", lastOpenedAt: 2, workspaceId: "ws-b" }],
    });
    expect(projects).toEqual([{ name: "b", lastOpenedAt: 2, workspaceId: "ws-b" }, { name: "a", lastOpenedAt: 1 }]);
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
    expect(decodeEnvironmentTarget({ thread: { path: 3 } })).toBeUndefined();
    expect(decodeEnvironmentTarget("x")).toBeUndefined();
  });
});
