import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpAppCapture } from "./events.js";
import { McpAppStore } from "./mcp-app-store.js";
import { McpApps, type McpAppReader } from "./mcp-apps.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const capture: McpAppCapture = { itemId: "i1", server: "fixture", tool: "counter", resourceUri: "ui://fixture/a.html", arguments: { start: 1 }, result: { content: [{ type: "text", text: "1" }], structuredContent: { count: 1 } } };
const resource = { contents: [{ uri: "ui://fixture/a.html", mimeType: "text/html;profile=mcp-app", text: "<p>raw</p>", _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] }, prefersBorder: true } } }] };

async function setup(openWaitMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), "tau-mcp-apps-flow-"));
  directories.push(directory);
  const store = new McpAppStore({ directory });
  const logged: string[] = [];
  return { store, apps: new McpApps(store, { log: (message) => logged.push(message), ...(openWaitMs !== undefined ? { openWaitMs } : {}) }), logged };
}

/** A reader whose answer the test releases. */
function gated(answer: () => unknown) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: unknown[] = [];
  const reader: McpAppReader = { codexThreadId: "codex-1", read: async (params) => { calls.push(params); await gate; return answer() as never; } };
  return { reader, release, calls };
}

describe("capturing an app", () => {
  it("reads with the item as origin, keeps the raw document with the call, and open then returns it", async () => {
    const { apps, store } = await setup();
    const { reader, release, calls } = gated(() => resource);
    apps.capture("t1", capture, reader);
    release();
    const opened = await apps.open("t1", "i1");
    expect(calls).toEqual([{ threadId: "codex-1", originCallId: "i1", server: "fixture", uri: "ui://fixture/a.html" }]);
    expect(opened).toMatchObject({ state: "ready", app: { html: "<p>raw</p>", meta: { server: "fixture", tool: "counter", prefersBorder: true, csp: { connectDomains: ["https://api.example.com"] }, toolInput: { start: 1 }, toolResult: { content: [{ type: "text", text: "1" }], structuredContent: { count: 1 } } } } });
    expect((await store.load("t1", "i1"))?.html).toBe("<p>raw</p>");
  });

  it("reads an item once while it is in flight", async () => {
    const { apps } = await setup();
    const { reader, release, calls } = gated(() => resource);
    apps.capture("t1", capture, reader);
    apps.capture("t1", capture, reader);
    release();
    await apps.open("t1", "i1");
    expect(calls).toHaveLength(1);
  });

  it("records a failed read as unavailable with a short reason and never throws", async () => {
    const { apps, logged } = await setup();
    apps.capture("t1", capture, { codexThreadId: "c", read: async () => { throw new Error("server went away"); } });
    expect(await apps.open("t1", "i1")).toEqual({ state: "unavailable", reason: "server went away" });
    apps.capture("t1", { ...capture, itemId: "i2" }, { codexThreadId: "c", read: async () => ({ contents: [{ uri: "ui://fixture/a.html", mimeType: "text/html", text: "x" }] }) });
    expect(await apps.open("t1", "i2")).toEqual({ state: "unavailable", reason: "The server returned no app document." });
    expect(logged).toHaveLength(2);
  });

  it("answers pending while the read runs past the wait, then ready", async () => {
    const { apps } = await setup(0);
    const { reader, release } = gated(() => resource);
    apps.capture("t1", capture, reader);
    expect(await apps.open("t1", "i1")).toEqual({ state: "pending" });
    release();
    await vi.waitFor(async () => expect(await apps.open("t1", "i1")).toMatchObject({ state: "ready" }));
  });

  it("opens a stored app without any capture, and says so for one never saved", async () => {
    const { apps, store } = await setup();
    await store.save("t1", "i1", { html: "<p>old</p>", meta: { server: "s", tool: "t", resourceUri: "ui://s/a", toolInput: {} } });
    expect(await apps.open("t1", "i1")).toMatchObject({ state: "ready" });
    expect(await apps.open("t1", "nope")).toEqual({ state: "unavailable", reason: "This app was not saved." });
  });
});
