import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ WebContentsView: vi.fn(), session: { fromPartition: vi.fn() } }));

const { captureWindowOnce, windowSourceId } = await import("./capture.js");

const frame = { seq: 1, url: "data:image/png;base64,AA==", width: 2, height: 1 };
const noPause = async () => undefined;

describe("the shared window capture", () => {
  it("names one window as a capture source and refuses anything else", () => {
    expect(windowSourceId(33962)).toBe("window:33962:0");
    for (const bad of [0, -1, 1.5, "33962", undefined, Number.NaN]) expect(() => windowSourceId(bad)).toThrow();
  });

  it("takes the first frame the recording draws, then stops it", async () => {
    const take = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(frame);
    const capture = { start: vi.fn(async () => undefined), take, stop: vi.fn() };

    await expect(captureWindowOnce(capture, { pause: noPause })).resolves.toEqual(frame);
    expect(take).toHaveBeenCalledTimes(3);
    expect(capture.stop).toHaveBeenCalledOnce();
  });

  it("stops the recording when the window closes or gives no picture", async () => {
    const ended = { start: vi.fn(async () => undefined), take: vi.fn(async () => ({ ended: true as const })), stop: vi.fn() };
    await expect(captureWindowOnce(ended, { pause: noPause })).rejects.toThrow(/closed/u);
    expect(ended.stop).toHaveBeenCalledOnce();

    const blank = { start: vi.fn(async () => undefined), take: vi.fn(async () => null), stop: vi.fn() };
    await expect(captureWindowOnce(blank, { pause: noPause, timeoutMs: 100, pollMs: 50 })).rejects.toThrow(/no picture/u);
    expect(blank.stop).toHaveBeenCalledOnce();
  });
});
