import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../src/renderer/test-support/kit-harness.js";
import type { ClientRelease, ClientStorage } from "tau";
import { ACTION_URL, sendActivity, STATISTICS_KEY, TRACKING_URL, trackingBody, UsageStatistics, type SendActivity } from "./statistics.js";

const release: ClientRelease = { version: "0.7.39", platform: "darwin", channel: "stable" };
const id = "0123456789abcdef";
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
afterEach(() => vi.unstubAllGlobals());

describe("device usage statistics", () => {
  it("does not mint an ID or send anything before explicit consent, or without an installed release", async () => {
    const storage = createMemoryStorage();
    const send = vi.fn<SendActivity>(async () => undefined);
    const newId = vi.fn(() => id);
    const statistics = new UsageStatistics(storage, send, Date.now, newId);
    statistics.start(release);
    statistics.record("human_prompt_accepted");
    await settle();
    expect(storage.get(STATISTICS_KEY)).toBeNull();
    expect(newId).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    statistics.start(undefined);
    statistics.setEnabled(true);
    statistics.record("workbench_used");
    await settle();
    expect(send).not.toHaveBeenCalled();
    statistics.dispose();
  });

  it("keeps one identity across clients of a device and sends each kind once per UTC day", async () => {
    const storage = createMemoryStorage();
    const send = vi.fn<SendActivity>(async () => undefined);
    let now = Date.parse("2026-10-09T23:59:59Z");
    const first = new UsageStatistics(storage, send, () => now, () => id);
    first.start(release);
    first.setEnabled(true);
    first.record("workbench_used");
    first.record("workbench_used");
    first.record("human_prompt_accepted");
    await settle();
    const second = new UsageStatistics(storage, send, () => now, () => "ffffffffffffffff");
    second.start(release);
    second.record("human_prompt_accepted");
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([report]) => report.id === id)).toBe(true);
    now += 2_000;
    second.record("human_prompt_accepted");
    await settle();
    expect(send).toHaveBeenCalledTimes(3);
    expect(JSON.parse(storage.get(STATISTICS_KEY)!)).toMatchObject({ id, day: "2026-10-10", sent: ["human_prompt_accepted"] });
    first.dispose(); second.dispose();
  });

  it("revocation aborts pending traffic, including before its first microtask, and reaches another window", async () => {
    const storage = createMemoryStorage();
    let signal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    const send = vi.fn<SendActivity>((_report, received: AbortSignal) => new Promise<void>((resolve) => { signal = received; finish = resolve; }));
    const statistics = new UsageStatistics(storage, send, Date.now, () => id);
    statistics.start(release); statistics.setEnabled(true);
    statistics.record("workbench_used"); statistics.setEnabled(false);
    await settle();
    expect(send).not.toHaveBeenCalled();
    statistics.setEnabled(true); statistics.record("workbench_used");
    await settle();
    const other = new UsageStatistics(storage, send);
    other.setEnabled(false);
    statistics.refresh();
    expect(signal?.aborted).toBe(true);
    finish!(); await settle();
    expect(statistics.getSnapshot()).toMatchObject({ enabled: false, id, sent: [] });
    statistics.record("human_prompt_accepted"); await settle();
    expect(send).toHaveBeenCalledTimes(1);
    statistics.dispose(); other.dispose();
  });

  it("bounds offline retries and does not mark failed delivery as sent", async () => {
    let now = Date.parse("2026-10-09T10:00:00Z");
    const send = vi.fn<SendActivity>(async () => { throw new Error("offline"); });
    const statistics = new UsageStatistics(createMemoryStorage(), send, () => now, () => id);
    statistics.start(release); statistics.setEnabled(true);
    statistics.record("human_prompt_accepted"); await settle();
    statistics.record("human_prompt_accepted"); await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(statistics.getSnapshot().sent).toEqual([]);
    now += 5 * 60_000;
    statistics.record("human_prompt_accepted"); await settle();
    expect(send).toHaveBeenCalledTimes(2);
    statistics.dispose();
  });

  it("fails closed when consent cannot be stored, including a failed revocation write", async () => {
    const storage = createMemoryStorage();
    let fail = false;
    const broken: ClientStorage = { ...storage, set: (key, value) => { if (fail) throw new Error("quota"); storage.set(key, value); } };
    const send = vi.fn<SendActivity>(async () => undefined);
    const statistics = new UsageStatistics(broken, send, Date.now, () => id);
    statistics.start(release); statistics.setEnabled(true);
    fail = true;
    statistics.setEnabled(false); statistics.record("human_prompt_accepted");
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(statistics.getSnapshot()).toMatchObject({ enabled: false, error: expect.any(String) });
    statistics.dispose();
  });

  it("sends only the agreed payload to Matomo without cookies, a referrer or a privileged token", async () => {
    const report = { id, event: "human_prompt_accepted" as const, release };
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    await sendActivity(report, abort.signal);
    expect(fetcher).toHaveBeenCalledWith(TRACKING_URL, expect.objectContaining({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: abort.signal }));
    expect(Object.fromEntries(trackingBody(report))).toEqual({
      idsite: "4", rec: "1", apiv: "1", cid: id, url: ACTION_URL,
      e_c: "tau", e_a: "human_prompt_accepted", ca: "1", send_image: "0", ua: "Tau", lang: "und", cookie: "0",
      dimension1: "0.7.39", dimension2: "darwin", dimension3: "stable",
    });
  });
});
