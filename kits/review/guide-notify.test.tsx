// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegionProps } from "tau";
import { createGuideRunWatcher, guideToast, watchGuideRuns } from "./guide-notify.js";
import { GUIDE_EVENT, type GuideEvent } from "./guide-protocol.js";
import { PULL_REQUEST_TAB } from "./protocol.js";
import { REVIEWS_PAGE } from "./local-reviews.js";

afterEach(() => { cleanup(); delete document.body.dataset.profile; });

const URL_7 = "https://github.com/acme/tau/pull/7";
const READY: GuideEvent = { url: URL_7, number: 7, kind: "ready", title: "Add the output helper" };

function hostWith() {
  const listeners: Array<(payload: unknown) => void> = [];
  const off = vi.fn();
  const host = { invoke: vi.fn(), onEvent: vi.fn((name: string, listener: (payload: unknown) => void) => { expect(name).toBe(GUIDE_EVENT); listeners.push(listener); return off; }) };
  return { host, emit: (payload: unknown) => listeners.forEach((listener) => listener(payload)), off };
}

function actions() {
  return { toast: vi.fn(), openStageTab: vi.fn(() => "tab"), openPage: vi.fn() };
}

describe("the toast when a guide run ends", () => {
  it("says the guide is ready and opens the request at its guide", () => {
    const toast = guideToast(READY, () => undefined)!;
    expect(toast).toMatchObject({ type: "success", title: "Review guide ready", description: "#7 Add the output helper" });
    expect(toast.actions?.map((action) => action.label)).toEqual(["Open"]);
  });

  it("says a run failed", () => {
    expect(guideToast({ ...READY, kind: "failed" }, () => undefined)).toMatchObject({ type: "error", title: "Review guide failed", description: "#7 Add the output helper" });
  });

  it("stays quiet when a run starts, and names a request without a title by its number", () => {
    expect(guideToast({ ...READY, kind: "running" }, () => undefined)).toBeUndefined();
    expect(guideToast({ url: URL_7, number: 7, kind: "ready" }, () => undefined)?.description).toBe("#7");
  });
});

describe("watching the runs", () => {
  it("shows the toast for the events that end a run, and Open goes to the guide tab", () => {
    const { host, emit } = hostWith();
    const current = actions();
    watchGuideRuns(host, () => current as never);
    emit({ ...READY, kind: "running" });
    emit({ nonsense: true });
    expect(current.toast).not.toHaveBeenCalled();
    emit(READY);
    expect(current.toast).toHaveBeenCalledTimes(1);
    current.toast.mock.calls[0]![0].actions[0].run();
    expect(current.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, expect.objectContaining({ url: URL_7, number: 7, service: "github", focus: "guide" }), { key: URL_7 });
  });

  it("opens the Reviews page on a phone", () => {
    document.body.dataset.profile = "compact";
    const { host, emit } = hostWith();
    const current = actions();
    watchGuideRuns(host, () => current as never);
    emit(READY);
    current.toast.mock.calls[0]![0].actions[0].run();
    expect(current.openPage).toHaveBeenCalledWith(REVIEWS_PAGE, expect.objectContaining({ tab: "remote", url: URL_7, focus: "guide" }));
  });

  it("is an invisible region that listens while mounted and lets go when it unmounts", () => {
    const { host, emit, off } = hostWith();
    const Watcher = createGuideRunWatcher(host);
    const current = actions();
    const view = render(<Watcher actions={current as unknown as RegionProps["actions"]} />);
    expect(view.container.innerHTML).toBe("");
    emit({ ...READY, kind: "failed" });
    expect(current.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    view.unmount();
    expect(off).toHaveBeenCalled();
  });
});
