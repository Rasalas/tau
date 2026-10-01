import { expect, it, vi } from "vitest";
import { CaptureService } from "./capture-service.js";

function service(overrides = {}) {
  const take = vi.fn(async () => ({ png: "window pixels" }));
  return { take, service: new CaptureService({ available: () => true, owner: async () => ":1.42", take, ...overrides }) };
}

it("accepts the registered caller and refuses another client without taking a screenshot", async () => {
  const { service: capture, take } = service();
  await expect(capture.capture(":1.24")).rejects.toThrow(/Only the Tau/u);
  expect(take).not.toHaveBeenCalled();
  expect(await capture.capture(":1.42")).toEqual({ png: "window pixels" });
});

it("refuses locked sessions and invalidates capture after the session locks", async () => {
  let available = false;
  const { service: capture, take } = service({ available: () => available });
  await expect(capture.capture(":1.42")).rejects.toThrow(/Unlock/u);
  expect(take).not.toHaveBeenCalled();
  available = true;
  take.mockImplementation(async () => { available = false; return { png: "private pixels" }; });
  await expect(capture.capture(":1.42")).rejects.toThrow(/Unlock/u);
});

it("refuses pixels after disabling the extension during authorization or capture", async () => {
  let authorize;
  const first = service({ owner: () => new Promise((resolve) => { authorize = resolve; }) });
  const pending = first.service.capture(":1.42");
  first.service.disable();
  authorize(":1.42");
  await expect(pending).rejects.toThrow(/enable Tau/u);
  expect(first.take).not.toHaveBeenCalled();
  const second = service();
  second.take.mockImplementation(async () => { second.service.disable(); return { png: "private pixels" }; });
  await expect(second.service.capture(":1.42")).rejects.toThrow(/enable Tau/u);
});

it("allows one capture at a time and releases its guard after a failed capture", async () => {
  let finish;
  const { service: capture, take } = service({ take: () => new Promise((_resolve, reject) => { finish = reject; }) });
  const pending = capture.capture(":1.42");
  await Promise.resolve();
  await expect(capture.capture(":1.42")).rejects.toThrow(/already in progress/u);
  finish(new Error("Compositor unavailable"));
  await expect(pending).rejects.toThrow(/unavailable/u);
  capture.take = take;
  expect(await capture.capture(":1.42")).toEqual({ png: "window pixels" });
});
