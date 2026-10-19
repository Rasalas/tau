import { afterEach, describe, expect, it, vi } from "vitest";
import { PullRequestCache, OFFLINE_REASON } from "./pull-request-cache.js";
import { pullRequestClient } from "./pull-request-client.js";
import { createMemoryStorage } from "../../src/renderer/test-support/kit-harness.js";

const url = "https://github.com/acme/app/pull/1";
const host = (value: unknown) => ({ invoke: vi.fn(async () => value), onEvent: () => () => undefined });

describe("request offline cache", () => {
  it("restores lists, details, conversations and diffs after recreating the client without RPCs", async () => {
    const storage = createMemoryStorage();
    const cache = new PullRequestCache(storage);
    const transport = host({ title: "Saved request" });
    const client = pullRequestClient(transport, cache);
    await client.view(url);
    transport.invoke.mockResolvedValue({ files: [], diffs: [{ path: "a.ts", hunks: [] }] });
    const files = await client.files(url);
    transport.invoke.mockResolvedValue([]);
    await client.threads(url);
    transport.invoke.mockResolvedValue({ entries: [{ title: "Saved request" }] });
    const list = await client.list({ workspace: "ws", state: "open", limit: 100 });
    cache.flush();
    transport.invoke.mockClear();
    const restored = pullRequestClient(transport, new PullRequestCache(storage, false));
    expect((await restored.view(url, true)).title).toBe("Saved request");
    expect(await restored.files(url, true)).toEqual(files);
    expect(await restored.threads(url)).toEqual([]);
    expect(await restored.list({ limit: 100, state: "open", workspace: "ws" })).toEqual(list);
    expect(transport.invoke).not.toHaveBeenCalled();
    await expect(restored.review(url, { event: "approve", body: "", comments: [] })).rejects.toThrow(OFFLINE_REASON);
    await expect(restored.action(url, { action: "merge" })).rejects.toThrow(OFFLINE_REASON);
    await expect(restored.link("thread", url)).rejects.toThrow(OFFLINE_REASON);
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("keeps storage scopes separate and stores no authentication fields", async () => {
    const a = createMemoryStorage();
    const b = createMemoryStorage();
    const transport = host({ title: "Only on A", token: "private", credentials: { password: "private" } });
    await pullRequestClient(transport, new PullRequestCache(a)).view(url);
    expect(JSON.stringify(a.keys().map((key) => a.get(key)))).not.toContain("private");
    expect(new PullRequestCache(b, false).peek("pr-view", { url })).toBeUndefined();
  });

  it("updates after reconnect and does not reuse another list question", async () => {
    const cache = new PullRequestCache(createMemoryStorage());
    const transport = host({ title: "Old" });
    const client = pullRequestClient(transport, cache);
    await client.view(url);
    cache.setConnected(false);
    transport.invoke.mockResolvedValue({ title: "New" });
    expect((await client.view(url)).title).toBe("Old");
    await expect(client.list({ state: "closed", limit: 100 })).rejects.toThrow("not been saved");
    cache.setConnected(true);
    expect((await client.view(url)).title).toBe("New");
    cache.setConnected(false);
    expect((await client.view(url)).title).toBe("New");
  });

  it("evicts complete old request groups and limits list questions", async () => {
    const cache = new PullRequestCache(createMemoryStorage());
    const transport = host({ title: "request" });
    for (let i = 0; i < 13; i++) {
      await cache.invoke(transport, "pr-view", { url: `${url}${i}` });
      await cache.invoke(transport, "pr-files", { url: `${url}${i}` });
    }
    expect(cache.peek("pr-view", { url: `${url}0` })).toBeUndefined();
    expect(cache.peek("pr-files", { url: `${url}0` })).toBeUndefined();
    expect(cache.peek("pr-view", { url: `${url}12` })).toBeDefined();
    for (let i = 0; i < 9; i++) await cache.invoke(transport, "pr-list", { search: String(i) });
    expect(cache.peek("pr-list", { search: "0" })).toBeUndefined();
    expect(cache.peek("pr-list", { search: "8" })).toBeDefined();
  });

  it("bounds bytes, skips oversized responses and tolerates corrupt or full storage", async () => {
    const storage = createMemoryStorage();
    storage.set("host:tau.review.offline.v1", "broken");
    const cache = new PullRequestCache(storage);
    const transport = host({ body: "x".repeat(350_000) });
    for (let i = 0; i < 10; i++) await cache.invoke(transport, "pr-view", { url: `${url}${i}` });
    cache.flush();
    expect(storage.get("host:tau.review.offline.v1")!.length * 2).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(cache.peek("pr-view", { url: `${url}0` })).toBeUndefined();
    transport.invoke.mockResolvedValue({ body: "x".repeat(600_000) });
    await cache.invoke(transport, "pr-view", { url });
    expect(cache.peek("pr-view", { url })).toBeUndefined();
    const full = new PullRequestCache({ ...storage, set: () => { throw new Error("quota"); } });
    transport.invoke.mockResolvedValue({ title: "Live" });
    await expect(full.invoke(transport, "pr-view", { url })).resolves.toEqual({ title: "Live" });
  });

  it("does not restore data from a late RPC after deactivation and removal", async () => {
    const storage = createMemoryStorage();
    const cache = new PullRequestCache(storage);
    let finish!: (value: unknown) => void;
    const transport = { ...host(null), invoke: () => new Promise((resolve) => { finish = resolve; }) };
    const request = cache.invoke(transport, "pr-view", { url });
    cache.stop();
    finish({ title: "Late" });
    await request;
    expect(storage.keys()).toEqual([]);
  });
});


it("retains an old request that was reopened offline before evicting untouched requests", async () => {
  const storage = createMemoryStorage();
  const cache = new PullRequestCache(storage);
  const transport = host({ title: "Saved" });
  for (let i = 0; i < 12; i++) await cache.invoke(transport, "pr-view", { url: `${url}${i}` });
  cache.setConnected(false);
  await cache.invoke(transport, "pr-view", { url: `${url}0` });
  cache.setConnected(true);
  await cache.invoke(transport, "pr-view", { url: `${url}12` });
  cache.flush();
  expect(cache.peek("pr-view", { url: `${url}0` })).toBeDefined();
  expect(cache.peek("pr-view", { url: `${url}1` })).toBeUndefined();
  expect(new PullRequestCache(storage, false).peek("pr-view", { url: `${url}0` })).toBeDefined();
});


it("does not recreate a cache cleared externally while a read was pending", async () => {
  const storage = createMemoryStorage();
  const cache = new PullRequestCache(storage);
  const transport = host({ title: "Before removal" });
  await cache.invoke(transport, "pr-view", { url });
  let finish!: (value: unknown) => void;
  const pendingHost = { ...transport, invoke: () => new Promise((resolve) => { finish = resolve; }) };
  const request = cache.invoke(pendingHost, "pr-view", { url });
  for (const key of storage.keys()) storage.remove(key);
  finish({ title: "Late" });
  await request;
  cache.flush();
  expect(storage.keys()).toEqual([]);
});


it("does not let list-row pipeline reads evict recently opened requests", async () => {
  const cache = new PullRequestCache(createMemoryStorage());
  const transport = host({ title: "Opened request" });
  await cache.invoke(transport, "pr-view", { url });
  transport.invoke.mockResolvedValue({});
  for (let i = 0; i < 20; i++) await cache.invoke(transport, "pr-pipeline", { url: `${url}${i}`, runs: [] });
  expect(cache.peek("pr-view", { url })).toBeDefined();
});


describe("writing the cache", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("writes the files of an opened request together, without reading the cache back", async () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const set = vi.spyOn(storage, "set");
    const get = vi.spyOn(storage, "get");
    const cache = new PullRequestCache(storage);
    const transport = host({ title: "request" });
    await cache.invoke(transport, "pr-view", { url });
    for (let i = 0; i < 30; i++) await cache.invoke(transport, "pr-file", { url, path: `src/${i}.ts` });
    expect(set).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(set).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(new PullRequestCache(storage, false).peek("pr-file", { url, path: "src/29.ts" })).toBeDefined();
  });

  it("writes a waiting save when stopped", async () => {
    const storage = createMemoryStorage();
    const cache = new PullRequestCache(storage);
    const transport = host({ title: "request" });
    await cache.invoke(transport, "pr-view", { url });
    await cache.invoke(transport, "pr-files", { url });
    cache.stop();
    expect(new PullRequestCache(storage, false).peek("pr-files", { url })).toBeDefined();
  });

  it("keeps a phone's cache small and shrinks one saved under the desktop's bound", async () => {
    const storage = createMemoryStorage();
    const transport = host({ body: "x".repeat(100_000) });
    const desktop = new PullRequestCache(storage);
    for (let i = 0; i < 10; i++) await desktop.invoke(transport, "pr-view", { url: `${url}${i}` });
    desktop.stop();
    expect(storage.get("host:tau.review.offline.v1")!.length * 2).toBeGreaterThan(1024 * 1024);
    vi.stubGlobal("document", { body: { dataset: { client: "compact" } }, addEventListener: () => undefined, removeEventListener: () => undefined });
    const phone = new PullRequestCache(storage);
    expect(storage.get("host:tau.review.offline.v1")!.length * 2).toBeLessThanOrEqual(512 * 1024);
    expect(phone.peek("pr-view", { url: `${url}9` })).toBeDefined();
    transport.invoke.mockResolvedValue({ body: "x".repeat(200_000) });
    await phone.invoke(transport, "pr-view", { url });
    expect(phone.peek("pr-view", { url })).toBeUndefined();
  });
});
