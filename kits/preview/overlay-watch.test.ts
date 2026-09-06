// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayWatch, blockingOverlayPresent } from "./overlay-watch.js";

function mount(className: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  document.body.append(element);
  return element;
}

/** The observer batches into a microtask and the watch answers on the next frame. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
}

afterEach(() => { document.body.innerHTML = ""; });

describe("blockingOverlayPresent", () => {
  it("counts every scrim a modal surface puts up", () => {
    for (const className of [
      "modal-scrim",
      "palette-backdrop",
      "project-picker-scrim",
      "project-modal-scrim",
      "attachment-lightbox",
      "reload-curtain",
    ]) {
      const element = mount(className);
      expect(blockingOverlayPresent(), className).toBe(true);
      element.remove();
    }
    expect(blockingOverlayPresent()).toBe(false);
  });

  it("counts a surface that opts in without wearing a scrim", () => {
    const element = mount("something-else");
    expect(blockingOverlayPresent()).toBe(false);
    element.setAttribute("data-preview-overlay", "");
    expect(blockingOverlayPresent()).toBe(true);
  });

  it("does not count the transient surfaces that are expected to keep clear", () => {
    for (const className of ["toast update-toast", "menu below right", "thread-cost-popover", "context-popover"]) {
      mount(className);
    }
    expect(blockingOverlayPresent()).toBe(false);
  });
});

describe("OverlayWatch", () => {
  it("hides while a scrim is up and shows again when it goes", async () => {
    const watch = new OverlayWatch();
    const seen: boolean[] = [];
    const stop = watch.subscribe((blocked) => seen.push(blocked));
    expect(seen).toEqual([false]);

    const scrim = mount("modal-scrim");
    await settle();
    expect(seen).toEqual([false, true]);
    expect(watch.isBlocked()).toBe(true);

    scrim.remove();
    await settle();
    expect(seen).toEqual([false, true, false]);
    stop();
  });

  it("leaves the preview alone for a toast", async () => {
    const watch = new OverlayWatch();
    const seen: boolean[] = [];
    const stop = watch.subscribe((blocked) => seen.push(blocked));

    const toast = mount("toast update-toast");
    await settle();
    toast.remove();
    await settle();

    expect(seen).toEqual([false]);
    stop();
  });

  it("tells a late subscriber that a modal is already up", async () => {
    const watch = new OverlayWatch();
    const stop = watch.subscribe(() => undefined);
    mount("palette-backdrop");
    await settle();

    const late = vi.fn();
    const stopLate = watch.subscribe(late);
    expect(late).toHaveBeenCalledWith(true);

    stopLate();
    stop();
  });

  it("answers once per frame however many mutations a batch carries", async () => {
    const watch = new OverlayWatch();
    const seen: boolean[] = [];
    const stop = watch.subscribe((blocked) => seen.push(blocked));

    mount("modal-scrim");
    for (let index = 0; index < 20; index += 1) mount(`transcript-row-${index}`);
    await settle();

    expect(seen).toEqual([false, true]);
    stop();
  });

  it("stops observing once the last subscriber leaves", async () => {
    const watch = new OverlayWatch();
    const seen: boolean[] = [];
    watch.subscribe((blocked) => seen.push(blocked))();

    mount("modal-scrim");
    await settle();
    expect(seen).toEqual([false]);
  });
});
