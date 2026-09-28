// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { deferred, deferredModule, preloadDeferred } from "./deferred";
import { LazyFeatureBoundary } from "./LazyFeature";

function Label({ text }: { text: string }) {
  return <span>{text}</span>;
}

describe("deferred", () => {
  it("shows nothing until its chunk arrives, then the component", async () => {
    let resolve!: (component: typeof Label) => void;
    const Deferred = deferred(() => new Promise<typeof Label>((done) => { resolve = done; }));
    const { container } = render(<Deferred text="menu" />);
    expect(container.textContent).toBe("");
    resolve(Label);
    expect(await screen.findByText("menu")).toBeTruthy();
  });

  it("renders synchronously once preloaded", async () => {
    const Deferred = deferred(async () => Label);
    await Deferred.preload();
    expect(renderToStaticMarkup(<Deferred text="ready" />)).toBe("<span>ready</span>");
  });

  it("keeps the instance mounted when its parent rerenders", async () => {
    const mounted = vi.fn();
    function Counter({ label }: { label: string }) {
      useState(mounted);
      return <span>{label}</span>;
    }
    const Deferred = deferred(async () => Counter);
    const { rerender } = render(<Deferred label="a" />);
    await screen.findByText("a");
    rerender(<Deferred label="b" />);
    expect(screen.getByText("b")).toBeTruthy();
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("does not load while `when` says it would draw nothing", () => {
    const load = vi.fn(async () => Label);
    const Deferred = deferred(load, ({ text }) => text.length > 0);
    const { container } = render(<Deferred text="" />);
    expect(container.textContent).toBe("");
    expect(load).not.toHaveBeenCalled();
  });

  it("tries again after a failed load", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(Label);
    const Deferred = deferred(load);
    await expect(Deferred.preload()).rejects.toThrow("offline");
    await Deferred.preload();
    expect(load).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(<Deferred text="back" />)).toBe("<span>back</span>");
  });

  it("loads again when a boundary's Retry follows a failed render", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(Label);
    const Deferred = deferred(load);
    render(<LazyFeatureBoundary label="menu"><Deferred text="back" /></LazyFeatureBoundary>);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("back")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("deferredModule", () => {
  it("loads once, then answers synchronously through `current`", async () => {
    const load = vi.fn(async () => ({ answer: 42 }));
    const module = deferredModule(load);
    expect(module.current).toBeUndefined();
    const [first, second] = await Promise.all([module(), module()]);
    expect(first).toBe(second);
    expect(module.current).toBe(first);
    expect(load).toHaveBeenCalledOnce();
  });

  it("is loaded with the deferred components", async () => {
    const module = deferredModule(async () => ({ ready: true }));
    await preloadDeferred();
    expect(module.current).toEqual({ ready: true });
  });

  it("tries again after a failed load", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ back: true });
    const module = deferredModule(load);
    await expect(module()).rejects.toThrow("offline");
    expect(module.current).toBeUndefined();
    await expect(module()).resolves.toEqual({ back: true });
  });
});
