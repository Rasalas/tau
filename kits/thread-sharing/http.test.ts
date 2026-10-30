import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostPublicTools, UiMessage } from "tau/host-extension";
import { guestRoute } from "./http.js";
import { GuestShares } from "./store.js";
import { guestTranscript } from "./projection.js";
import { GUEST_PATH, type GuestView } from "./protocol.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = "https://guest.example";
const browserToken = (link: { id: string }, char = "a") => `taub.${link.id}.${char.repeat(43)}`;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tau-guest-http-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let time = 1_800_000_000_000;
  const file = join(directory, "guest-links.json");
  let store = await GuestShares.open(file, { now: () => time });
  await store.setEnabled(true);
  const threads = new Map<string, UiMessage[]>([
    ["one", [{ id: "u1", role: "user", text: "Shared question", timestamp: 0 }, { id: "a1", role: "assistant", text: "Shared answer", thinking: "PRIVATE REASONING", timestamp: 0 }]],
    ["two", [{ id: "u2", role: "user", text: "OTHER THREAD SECRET", timestamp: 0 }]],
  ]);
  const tools = new Map<string, HostPublicTools>();
  let live = true;
  let read: (id: string, grantId: string) => Promise<Omit<GuestView, "mode" | "expiresAt" | "suggestions">> = async (id, grantId) => {
    if (!live) { const cached = store.cached(id, grantId); if (!cached) throw new Error("No cached projection"); return cached; }
    const view = { title: "Chosen thread", machine: "Test machine", ...guestTranscript(threads.get(id)!, tools.get(id), store.outputAllowed(id, grantId)) };
    await store.cache(id, view, grantId);
    return view;
  };
  let route = guestRoute({ store, origins: () => [origin], eligible: async (id) => threads.has(id), view: (id, grantId) => read(id, grantId), now: () => time });
  const server: Server = createServer((request, response) => {
    void route(request, response, "loopback").then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No isolated HTTP listener");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (suffix: string, token?: string, input?: unknown, extra: HeadersInit = {}) => fetch(base + GUEST_PATH + suffix, {
    method: input === undefined ? "GET" : "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input === undefined ? {} : { "Content-Type": "application/json", Origin: origin }), ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return {
    file, request, threads, tools, get store() { return store; }, advance: (ms: number) => { time += ms; }, closeRuntime: () => { live = false; },
    setRead: (next: typeof read) => { read = next; },
    restart: async () => { store.close(); store = await GuestShares.open(file, { now: () => time }); route = guestRoute({ store, origins: () => [origin], eligible: async (id) => threads.has(id), view: (id, grantId) => read(id, grantId), now: () => time }); },
  };
}
async function claim(f: Awaited<ReturnType<typeof fixture>>, mode: "watch" | "suggest" = "suggest", showToolOutput = false) {
  const link = await f.store.create("one", "Chosen", 1, mode, showToolOutput);
  const token = browserToken(link);
  expect((await f.request("/claim", link.token, { browserToken: token })).status).toBe(200);
  return { link, token };
}

describe("isolated real guest HTTP route", () => {
  it("reveals only the selected thread's allowlisted text, with no metadata, tool results or reasoning", async () => {
    const f = await fixture();
    f.threads.get("one")!.push(
      { id: "shell", role: "user", kind: "shell", text: "PRIVATE SHELL", timestamp: 0 },
      { id: "notice", role: "notice", text: "PRIVATE SYSTEM PROMPT", timestamp: 0, compaction: { summary: "PRIVATE SUMMARY" } },
      { id: "local", role: "user", excludedFromContext: true, text: "PRIVATE LOCAL COMMAND", timestamp: 0 },
      { id: "a", role: "assistant", text: "Public final", thinking: "PRIVATE THOUGHT", images: [{ mimeType: "image/png", data: "PRIVATE IMAGE" }], sourceEntryId: "/home/owner/secret", error: "PRIVATE ERROR", timestamp: 0 },
    );
    const { token, link } = await claim(f);
    const response = await f.request("/view", token);
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expect(serialized).toContain("Public final");
    for (const forbidden of ["PRIVATE", "OTHER THREAD", "sourceEntryId", "sessionId", "threadId", "timestamp", "thinking", "images", link.token, token]) expect(serialized).not.toContain(forbidden);
    const view = JSON.parse(serialized) as GuestView;
    expect(view.messages[0]).toEqual({ role: "user", text: "Shared question" });
    for (const suffix of ["/view?threadId=two", "/view?token=" + token, "/../files", "/tools", "/terminal", "/rpc", "/mcp", "/view/../../resources/private"]) expect((await f.request(suffix, token)).status).not.toBe(200);
    expect((await f.request("/view", link.token)).status).toBe(403);
    expect((await f.request("/view")).status).toBe(403);
    expect((await f.request("/view", "owner-access-key")).status).toBe(403);
  });
  it("rejects wrong, expired, revoked and replaced credentials and retains claims across restart", async () => {
    const f = await fixture();
    const { token, link } = await claim(f);
    expect((await f.request("/view", token.slice(0, -1) + "x")).status).toBe(403);
    await f.restart();
    expect((await f.request("/view", token)).status).toBe(200);
    expect((await f.request("/claim", link.token, { browserToken: browserToken(link, "b") })).status).toBe(409);
    expect((await f.request("/claim", link.token, { browserToken: token })).status).toBe(200);
    const replacement = await f.store.create("one", "Replacement", 1, "watch");
    expect((await f.request("/view", token)).status).toBe(403);
    const next = browserToken(replacement);
    expect((await f.request("/claim", replacement.token, { browserToken: next })).status).toBe(200);
    await f.store.revoke(replacement.id);
    expect((await f.request("/view", next)).status).toBe(403);
    await f.restart();
    expect((await f.request("/view", next)).status).toBe(403);
    const expiring = await claim(f);
    f.advance(3_600_001);
    expect((await f.request("/view", expiring.token)).status).toBe(403);
    expect((await f.request("/claim", expiring.link.token, { browserToken: expiring.token })).status).toBe(403);
    await f.restart();
    expect((await f.request("/view", expiring.token)).status).toBe(403);
  });
  it("stores hashes with private file permissions, never bearer credentials", async () => {
    const f = await fixture();
    const { link, token } = await claim(f);
    const content = await readFile(f.file, "utf8");
    expect(content).toContain("linkHash"); expect(content).toContain("browserHash");
    expect(content).not.toContain(token); expect(content).not.toContain(link.token);
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  });
  it("allows only one browser, including simultaneous claims", async () => {
    const f = await fixture();
    const link = await f.store.create("one", "Chosen", 8, "watch");
    const responses = await Promise.all(["a", "b"].map((c) => f.request("/claim", link.token, { browserToken: browserToken(link, c) })));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  it("checks revocation and eligibility again after an in-flight transcript read", async () => {
    const f = await fixture(); const { token, link } = await claim(f);
    let release!: () => void; let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.setRead(async () => { entered(); await blocked; return { title: "Old", machine: "Test", messages: [{ role: "assistant", text: "Must never escape" }], tools: [], truncated: false }; });
    const response = f.request("/view", token);
    await started; await f.store.revoke(link.id); release();
    const received = await response;
    expect(received.status).toBe(403); expect(await received.text()).not.toContain("Must never escape");
  });
  it("ends access when the selected thread disappears, never falls back to another thread", async () => {
    const f = await fixture(); const { token } = await claim(f);
    f.threads.delete("one");
    expect((await f.request("/view", token)).status).toBe(403);
    f.threads.set("one", []);
    expect((await f.request("/view", token)).status).toBe(403);
  });
  it("exposes names/status by default and persists only explicitly opted-in tool output across restart", async () => {
    const f = await fixture();
    f.tools.set("one", { tools: [{ name: "bash", status: "running", output: "Visible partial" }, { name: "read", status: "error" }], truncated: false });
    f.tools.set("two", { tools: [{ name: "bash", status: "done", output: "OTHER THREAD SECRET" }], truncated: false });
    const off = await claim(f);
    expect((await (await f.request("/view", off.token)).json()).tools).toEqual([{ name: "bash", status: "running" }, { name: "read", status: "error" }]);
    expect(await readFile(f.file, "utf8")).not.toContain("Visible partial");
    const on = await claim(f, "watch", true);
    const view = await (await f.request("/view", on.token)).json();
    expect(view.tools).toEqual([{ name: "bash", status: "running", output: "Visible partial" }, { name: "read", status: "error" }]);
    expect(JSON.stringify(view)).not.toContain("OTHER THREAD");
    f.tools.set("one", { tools: [{ name: "bash", status: "done", output: "Visible complete" }], truncated: false });
    expect((await (await f.request("/view", on.token)).json()).tools[0]).toEqual({ name: "bash", status: "done", output: "Visible complete" });
    f.closeRuntime(); await f.restart();
    expect((await (await f.request("/view", on.token)).json()).tools[0]?.output).toBe("Visible complete");
    await f.store.setEnabled(false);
    expect((await f.request("/view", on.token)).status).toBe(403);
    await f.store.setEnabled(true);
    expect((await f.request("/view", on.token)).status).toBe(200);
    await f.store.revoke(on.link.id); await f.restart();
    expect((await f.request("/view", on.token)).status).toBe(403);
    expect(await readFile(f.file, "utf8")).not.toContain("Visible complete");
  });
  it("rechecks the grant after a tool read when revoked, paused, replaced or expired", async () => {
    for (const action of ["revoke", "pause", "replace", "expire"] as const) {
      const f = await fixture(); const { token, link } = await claim(f, "watch", true);
      let release!: () => void; let entered!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      f.setRead(async () => { entered(); await wait; return { title: "Chosen", machine: "Machine", messages: [], tools: [{ name: "bash", status: "done", output: "Must never escape" }], truncated: false }; });
      const pending = f.request("/view", token); await started;
      if (action === "revoke") await f.store.revoke(link.id);
      if (action === "pause") await f.store.setEnabled(false);
      if (action === "replace") await f.store.create("one", "Replacement", 1, "watch");
      if (action === "expire") f.advance(3_600_001);
      release(); const response = await pending;
      expect(response.status).toBe(403); expect(await response.text()).not.toContain("Must never escape");
    }
  });
  it("allowlists HTTP objects and enforces output consent and combined limits even for a malformed view provider", async () => {
    const f = await fixture();
    const source = { title: "Chosen", machine: "Machine", messages: [], tools: [{ name: "bash", status: "done" as const, output: "Visible text", args: { password: "PRIVATE" }, id: "PRIVATE" }], truncated: false, session: { secret: "PRIVATE" }, thinking: "PRIVATE" };
    f.setRead(async () => source);
    const off = await claim(f);
    const serialized = await (await f.request("/view", off.token)).text();
    expect(JSON.parse(serialized).tools).toEqual([{ name: "bash", status: "done" }]);
    expect(serialized).not.toContain("PRIVATE"); expect(serialized).not.toContain("Visible text");
    const on = await claim(f, "watch", true);
    f.setRead(async () => ({ title: "Chosen", machine: "Machine", messages: [], tools: Array.from({ length: 600 }, () => ({ name: "bash", status: "done", output: "x".repeat(40_000) })), truncated: false }));
    const view = await (await f.request("/view", on.token)).json() as GuestView;
    expect(view.truncated).toBe(true);
    expect(view.tools.length).toBeLessThanOrEqual(500);
    expect(view.tools.reduce((sum, tool) => sum + tool.name.length + (tool.output?.length ?? 0), 0)).toBeLessThanOrEqual(200_000);
  });
  it("queues suggestions for explicit moderation; Watch cannot suggest and disabling drops attachments", async () => {
    const f = await fixture(); const { token, link } = await claim(f);
    const deliver = vi.fn(async () => undefined);
    expect((await f.request("/suggest", token, { text: "Please review this", images: [] })).status).toBe(200);
    expect(deliver).not.toHaveBeenCalled();
    expect((await f.request("/suggest", token, { text: "Second" })).status).toBe(409);
    const suggestion = f.store.list()[0]!.suggestions[0]!;
    await Promise.allSettled([f.store.moderate(link.id, suggestion.id, true, deliver), f.store.moderate(link.id, suggestion.id, true, deliver)]);
    expect(deliver).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledWith("one", expect.objectContaining({ state: "sent" }), expect.any(Function));
    expect(f.store.list()[0]!.suggestions[0]!.images).toEqual([]);
    const watch = await claim(f, "watch");
    expect((await f.request("/suggest", watch.token, { text: "Unauthorized" })).status).toBe(403);
    await f.store.setEnabled(false);
    expect((await f.request("/view", watch.token)).status).toBe(403);
    expect(f.store.list()[0]!.suggestions).toEqual([]);
    await f.store.setEnabled(true);
    expect((await f.request("/view", watch.token)).status).toBe(200);
  });
  it("bounds and validates adversarial bodies, refuses origins, and sends an inert CSP", async () => {
    const f = await fixture(); const { token } = await claim(f);
    for (const input of [{ text: "x".repeat(8001) }, { text: "", images: [{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }] }, { text: "x", images: [{ mimeType: "image/png", data: "PGh0bWw+" }] }, { text: "x", threadId: "two", tool: "exec", secret: "private" }]) expect((await f.request("/suggest", token, input)).status).toBe(400);
    expect((await f.request("/suggest", token, { text: "x" }, { Origin: "https://evil.example" })).status).toBe(403);
    const page = await f.request(""); const html = await page.text();
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).not.toContain(token);
    const script = await (await f.request("/client.js")).text();
    expect(script).toContain("history.replaceState"); expect(script).toContain("text.textContent = message.text");
    expect(script).not.toContain("innerHTML"); expect(script).not.toContain("WebSocket");
    f.advance(60_001);
    const accepted = await f.request("/suggest", token, { text: '<script>alert(1)</script> ![tracking](https://evil.example/pixel)' });
    expect(accepted.status).toBe(200);
  });
  it("accepts bounded raster images only into moderation and rejects oversized requests", async () => {
    const f = await fixture(); const { token } = await claim(f);
    const png = { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CFQAAAAASUVORK5CYII=" };
    expect((await f.request("/suggest", token, { text: "", images: [png] })).status).toBe(200);
    expect(f.store.list()[0]!.suggestions[0]!.images).toEqual([png]);
    expect((await f.request("/suggest", token, { text: "x", images: Array(5).fill(png) })).status).toBe(400);
    expect((await f.request("/suggest", token, { text: "x".repeat(15 * 1024 * 1024) })).status).toBe(413);
  });
  it("rate limits claims and suggestions without trusting forwarded addresses", async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) expect((await f.request("/claim", "invalid", { browserToken: "invalid" }, { "X-Forwarded-For": `10.0.0.${i}` })).status).toBe(403);
    expect((await f.request("/claim", "invalid", { browserToken: "invalid" })).status).toBe(429);
  });
});
