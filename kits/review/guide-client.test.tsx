// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { guideClient, guideEvent, useGuide } from "./guide-client.js";
import { GUIDE_EVENT, GUIDE_GET_COMMAND, GUIDE_WRITE_COMMAND } from "./guide-protocol.js";
import { fakeGuideClient, HEAD, sampleGuide } from "./guide-test-support.js";

afterEach(cleanup);

const URL_7 = "https://github.com/acme/tau/pull/7";

describe("the guide client", () => {
  it("asks the host for a request's guide and starts a run with the thread it comes from", async () => {
    const invoke = vi.fn(async () => ({ guide: null, run: null, currentHeadSha: HEAD, enabled: true }));
    const client = guideClient({ invoke, onEvent: () => () => undefined });
    await client.get(URL_7);
    await client.write(URL_7, { cwd: "/project", threadId: "thread-1" });
    await client.write(URL_7);
    expect(invoke.mock.calls).toEqual([
      [GUIDE_GET_COMMAND, { url: URL_7 }],
      [GUIDE_WRITE_COMMAND, { url: URL_7, cwd: "/project", threadId: "thread-1" }],
      [GUIDE_WRITE_COMMAND, { url: URL_7 }],
    ]);
  });

  it("passes on the events that name a request and ignores the rest", () => {
    const host: Pick<HostExtensionClient, "invoke" | "onEvent"> = { invoke: async () => undefined, onEvent: vi.fn() };
    const heard: unknown[] = [];
    const off = vi.fn();
    vi.mocked(host.onEvent).mockImplementation((name, listener) => {
      expect(name).toBe(GUIDE_EVENT);
      listener({ url: URL_7, number: 7, kind: "ready", title: "T" });
      listener({ url: URL_7, number: 7, kind: "other" });
      listener(undefined);
      listener({ number: 7, kind: "ready" });
      return off;
    });
    expect(guideClient(host).onChanged((event) => heard.push(event))).toBe(off);
    expect(heard).toEqual([{ url: URL_7, number: 7, kind: "ready", title: "T" }]);
    expect(guideEvent("x")).toBeUndefined();
  });
});

describe("useGuide", () => {
  it("reads on mount and reads again when the host says the run ended", async () => {
    const client = fakeGuideClient({ run: { state: "running", headSha: HEAD, startedAt: "t" } });
    const { result } = renderHook(() => useGuide(client, URL_7));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.result?.run?.state).toBe("running"));
    expect(result.current.running).toBe(true);
    expect(result.current.loading).toBe(false);
    act(() => client.publish({ run: null, guide: sampleGuide() }));
    await waitFor(() => expect(result.current.result?.guide?.stops).toHaveLength(3));
    expect(result.current.running).toBe(false);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it("does not read for another request's event, and stops listening when it unmounts", async () => {
    const client = fakeGuideClient();
    const { result, unmount } = renderHook(() => useGuide(client, "https://github.com/acme/tau/pull/9"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => client.publish({}));
    expect(client.get).toHaveBeenCalledTimes(1);
    unmount();
    expect(client.listeners.size).toBe(0);
  });

  it("starts a run, holds the answer and runs while the request is on its way", async () => {
    const client = fakeGuideClient();
    const { result } = renderHook(() => useGuide(client, URL_7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.write({ cwd: "/project", threadId: "thread-1" }); });
    expect(client.write).toHaveBeenCalledWith(URL_7, { cwd: "/project", threadId: "thread-1" });
    expect(result.current.result?.run?.state).toBe("running");
    expect(result.current.running).toBe(true);
  });

  it("says why a run did not start, and what a failed read said", async () => {
    const client = fakeGuideClient();
    client.write.mockResolvedValueOnce({ guide: null, run: null, currentHeadSha: HEAD, enabled: true, outcome: "failed", detail: "Open a checkout of acme/tau first." });
    const { result } = renderHook(() => useGuide(client, URL_7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.write(); });
    expect(result.current.error).toBe("Open a checkout of acme/tau first.");
    expect(result.current.running).toBe(false);

    client.get.mockRejectedValueOnce(new Error("host gone"));
    act(() => client.publish({}));
    await waitFor(() => expect(result.current.error).toBe("host gone"));
  });

  it("is idle without a client", async () => {
    const { result } = renderHook(() => useGuide(undefined, URL_7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.result).toBeUndefined();
    await expect(result.current.write()).resolves.toBeUndefined();
  });
});
