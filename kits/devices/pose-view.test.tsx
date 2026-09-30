// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import DevicePoseView from "./pose-view.js";
import type { Device, FoldState } from "./protocol.js";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
class PointerEventShim extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
}
if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: PointerEventShim });
const device: Device = { hostId: "local", id: "fold", platform: "android", name: "Pixel Fold", version: "35", booted: true };
const open: FoldState = { supported: true, posture: "opened", hingeAngle: 180 };
function load(container: HTMLElement, width: number, height: number) {
  const probe = container.querySelector<HTMLImageElement>(".devices-pose-probe")!;
  Object.defineProperties(probe, { naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height } });
  fireEvent.load(probe);
}
it("renders disjoint native capture regions, a solid back for each panel, and a preview-only hinge", () => {
  const { container } = render(<DevicePoseView image="open.png" device={device} fold={open} />);
  load(container, 1800, 2200);
  expect([...container.querySelectorAll("[data-crop]")].map((element) => element.getAttribute("data-crop"))).toEqual(["0,0,0.5,1", "0.5,0,0.5,1"]);
  expect(container.querySelectorAll(".devices-pose-back")).toHaveLength(2);
  expect(container.querySelectorAll(".devices-pose-edge")).toHaveLength(8);
  fireEvent.change(screen.getByRole("slider", { name: "3D preview hinge" }), { target: { value: "90" } });
  expect([...container.querySelectorAll<HTMLElement>("[data-panel]")].map((element) => element.style.transform)).toEqual(["rotateY(45deg)", "rotateY(-45deg)"]);
  expect(screen.getByText(/Preview hinge changes this view only/)).toBeTruthy();
  fireEvent.change(screen.getByRole("slider", { name: "3D preview hinge" }), { target: { value: "0" } });
  expect(container.querySelectorAll("[data-crop]")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Follow device posture" }));
  expect(container.querySelector("[data-angle]")?.getAttribute("data-angle")).toBe("180");
});
it("shows a changed closed capture only on the outward-facing cover and follows confirmed native angles", () => {
  const { container, rerender } = render(<DevicePoseView image="open.png" device={device} fold={open} />);
  load(container, 1800, 2200);
  rerender(<DevicePoseView image="closed.png" device={device} fold={{ ...open, posture: "closed", hingeAngle: 0 }} />);
  load(container, 1000, 2200);
  expect(container.querySelector("[data-surface]")?.getAttribute("data-surface")).toBe("cover");
  expect(container.querySelectorAll(".devices-pose-front img")).toHaveLength(0);
  expect(container.querySelectorAll(".devices-pose-back img")).toHaveLength(1);
  expect(container.querySelector(".devices-pose-back [data-crop]")?.getAttribute("data-crop")).toBe("0,0,1,1");
  rerender(<DevicePoseView image="unknown.png" device={device} />);
  load(container, 1000, 2200);
  expect(container.querySelectorAll("[data-crop]")).toHaveLength(0);
});
it("orbits with pointer capture, zooms with the wheel and resets the view", () => {
  const { container } = render(<DevicePoseView image="phone.png" device={{ ...device, platform: "ios", name: "iPhone" }} />);
  load(container, 1000, 2000);
  const scene = screen.getByRole("img", { name: "iPhone 3D inspection" });
  scene.setPointerCapture = vi.fn();
  fireEvent.pointerDown(scene, { pointerId: 1, button: 0, clientX: 20, clientY: 30 });
  fireEvent.pointerMove(scene, { pointerId: 1, clientX: 120, clientY: 30 });
  expect(container.querySelector<HTMLElement>(".devices-pose-body")?.style.transform).toContain("rotateY(36deg)");
  fireEvent.pointerCancel(scene);
  fireEvent.pointerMove(scene, { pointerId: 1, clientX: 220, clientY: 30 });
  expect(container.querySelector<HTMLElement>(".devices-pose-body")?.style.transform).toContain("rotateY(36deg)");
  fireEvent.wheel(scene, { deltaY: -200 });
  expect(container.querySelector<HTMLElement>(".devices-pose-body")?.style.transform).toContain("scale(1.2)");
  fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
  expect(container.querySelector<HTMLElement>(".devices-pose-body")?.style.transform).toContain("rotateY(-24deg)");
});

it("copies exact decoded video regions into the panels and releases its frame callbacks", () => {
  const drawImage = vi.fn(), cancel = vi.spyOn(window, "cancelAnimationFrame");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const source = document.createElement("canvas"); source.width = 1801; source.height = 2201;
  const { container, unmount } = render(<DevicePoseView image="fallback.png" source={source} device={device} fold={open} />);
  expect(container.querySelectorAll(".devices-pose-display canvas")).toHaveLength(2);
  expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 900, 2201, 0, 0, 900, 2201);
  expect(drawImage).toHaveBeenCalledWith(source, 900, 0, 901, 2201, 0, 0, 901, 2201);
  unmount();
  expect(cancel).toHaveBeenCalledTimes(2);
});
