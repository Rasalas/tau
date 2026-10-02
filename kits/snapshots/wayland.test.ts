import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({ desktopCapturer: { getSources: vi.fn() } }));
const { captureWaylandWindow } = await import("./wayland.js");
const image = { isEmpty: () => false, getSize: () => ({ width: 400, height: 300 }), toPNG: () => Buffer.from("png") };

it("captures only the portal-selected window and never guesses accessibility identity", async () => {
  const select = vi.fn(async () => [{ id: "window:123:0", name: "Chosen document", thumbnail: image }]);
  const capture = await captureWaylandWindow(select, () => 1234);
  expect(select).toHaveBeenCalledOnce();
  expect(capture).toMatchObject({ app: "Selected source", title: "Chosen document", pid: 0, capturedAt: 1234, image: { width: 400, height: 300, mimeType: "image/png" } });
  expect(capture.accessibility).toBeUndefined();
  expect(capture.accessibilityNote).toMatch(/does not identify/u);
});
it("never falls back after cancellation, denial, an empty picture or a malformed selection", async () => {
  await expect(captureWaylandWindow(async () => [])).rejects.toThrow(/cancelled/u);
  await expect(captureWaylandWindow(async () => { throw new Error("denied"); })).rejects.toThrow(/denied/u);
  await expect(captureWaylandWindow(async () => [{ id: "invalid:1:0", name: "Desktop", thumbnail: image }])).rejects.toThrow(/invalid/u);
  await expect(captureWaylandWindow(async () => [{ id: "window:1:0", name: "Window", thumbnail: { ...image, isEmpty: () => true } }])).rejects.toThrow(/no picture/u);
  await expect(captureWaylandWindow(async () => [{ id: "window:1:0", name: "A", thumbnail: image }, { id: "window:2:0", name: "B", thumbnail: image }])).rejects.toThrow(/one selected/u);
});
it("requests the delegated portal picker at capture time", async () => {
  const { desktopCapturer } = await import("electron");
  vi.mocked(desktopCapturer.getSources).mockResolvedValue([{ id: "window:123:0", name: "Document", thumbnail: image }] as never);
  await captureWaylandWindow();
  expect(desktopCapturer.getSources).toHaveBeenCalledWith({ types: ["window", "screen"], thumbnailSize: { width: 1920, height: 1920 }, fetchWindowIcons: false });
});
