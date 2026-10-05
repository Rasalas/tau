// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { PHONE_HOME, type PhoneRoute } from "../../workbench/phone-route";
import { phoneReaderFromState, routeFromState } from "../../workbench/phone-history";
import { TestProviders, TestThreadStore } from "../test-support/test-providers";
import { TouchLayer } from "../touch/TouchLayer";
import { AttachmentLightbox } from "./AttachmentLightbox";

const images = [{ key: "one", src: "data:image/png;base64,AAAA", alt: "Test image" }];
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

it("closes when tapping the space around the image, but keeps image taps open", () => {
  const close = vi.fn();
  render(<AttachmentLightbox images={images} index={0} onClose={close} />);
  const image = screen.getByRole("img", { name: "Test image" });
  fireEvent.click(image);
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(image.parentElement!);
  expect(close).toHaveBeenCalledOnce();
});

it("pinches out and back to fit without closing the preview", () => {
  const close = vi.fn();
  render(<AttachmentLightbox images={images} index={0} onClose={close} />);
  const image = screen.getByRole("img", { name: "Test image" });
  const touches = (distance: number) => [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }];
  fireEvent.touchStart(image, { touches: touches(100) });
  fireEvent.touchMove(image, { touches: touches(200) });
  expect(image.style.transform).toContain("scale(2)");
  expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy();
  fireEvent.touchMove(image, { touches: touches(50) });
  expect(image.style.transform).toBe("");
  expect(close).not.toHaveBeenCalled();
});

it.each(["back", "button"])("returns from a phone preview to the same route via %s", async (method) => {
  window.history.replaceState({}, "", "/?profile=compact");
  function Harness() {
    const [route, setRoute] = useState<PhoneRoute>(PHONE_HOME);
    const [shown, setShown] = useState(false);
    return <><TouchLayer syncUrl phone={{ route, onRoute: setRoute }} openThread={async () => true} />
      <button onClick={() => setShown(true)}>Open image</button>
      {shown ? <AttachmentLightbox images={images} index={0} onClose={() => setShown(false)} /> : null}
    </>;
  }
  render(<TestProviders><TestThreadStore threads={[]}><Harness /></TestThreadStore></TestProviders>);
  await waitFor(() => expect(routeFromState(window.history.state)).toEqual(PHONE_HOME));
  screen.getByRole("button", { name: "Open image" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Open image" }));
  await waitFor(() => expect(phoneReaderFromState(window.history.state)?.route).toEqual(PHONE_HOME));
  if (method === "back") window.history.back();
  else fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(routeFromState(window.history.state)).toEqual(PHONE_HOME);
  expect(phoneReaderFromState(window.history.state)).toBeUndefined();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open image" }));
});

it("shows video controls in the same lightbox without autoplay or stealing seek keys", () => {
  render(<AttachmentLightbox images={[...images, { key: "clip", kind: "video", src: "https://host/clip.mp4", alt: "Recording" }]} index={1} onClose={() => undefined} />);
  const video = document.querySelector("video")!;
  expect(video.controls).toBe(true);
  expect(video.autoplay).toBe(false);
  expect(screen.queryByRole("button", { name: "Copy image" })).toBeNull();
  fireEvent.keyDown(video, { key: "ArrowLeft" });
  expect(document.querySelector("video")).toBe(video);
  fireEvent.click(screen.getByRole("button", { name: "Previous media" }));
  expect(document.querySelector("video")).toBeNull();
  expect(screen.getByRole("img", { name: "Test image" })).toBeTruthy();
});

it("zooms with double click and closes on a downward swipe at fit", () => {
  const close = vi.fn();
  render(<AttachmentLightbox images={images} index={0} onClose={close} />);
  const image = screen.getByRole("img", { name: "Test image" });
  fireEvent.doubleClick(image);
  expect(image.style.transform).toContain("scale(2.5)");
  fireEvent.click(screen.getByRole("button", { name: "Fit" }));
  fireEvent.touchStart(image, { touches: [{ clientX: 10, clientY: 10 }] });
  fireEvent.touchEnd(image, { changedTouches: [{ clientX: 10, clientY: 150 }] });
  expect(close).toHaveBeenCalledOnce();
});
