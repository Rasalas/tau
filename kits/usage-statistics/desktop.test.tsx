// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEnvironmentProvider, createMemoryStorage, electronClientEnvironment } from "../../src/renderer/test-support/kit-harness.js";
import type { ToastOptions } from "tau";
import { StatisticsActivity, StatisticsSettings } from "./desktop.js";
import { UsageStatistics, type SendActivity } from "./statistics.js";

afterEach(cleanup);

describe("usage statistics consent", () => {
  it("requires an explicit choice, shows the deletion ID, and stops sending when switched off", async () => {
    const environment = electronClientEnvironment(new URLSearchParams("clientRelease=0.7.39&clientPlatform=darwin"));
    const send = vi.fn<SendActivity>(async () => undefined);
    const statistics = new UsageStatistics(createMemoryStorage(), send, Date.now, () => "0123456789abcdef");
    render(<ClientEnvironmentProvider environment={environment}>
      <StatisticsActivity statistics={statistics} /><StatisticsSettings statistics={statistics} />
    </ClientEnvironmentProvider>);
    const control = await screen.findByRole("switch", { name: "Share usage statistics" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    act(() => statistics.record("human_prompt_accepted"));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByText("0123456789abcdef")).toBeTruthy();
    expect(screen.getByRole("link", { name: "info@tbuck.de" }).getAttribute("href")).toBe("mailto:info@tbuck.de");
    act(() => statistics.record("human_prompt_accepted"));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.click(control);
    act(() => statistics.record("workbench_used"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(1);
    expect(control.getAttribute("aria-checked")).toBe("false");
    statistics.dispose();
  });

  it("disables reporting in development and isolated instances even if consent was saved", async () => {
    const send = vi.fn<SendActivity>(async () => undefined);
    const statistics = new UsageStatistics(createMemoryStorage(), send, Date.now, () => "0123456789abcdef");
    statistics.setEnabled(true);
    render(<ClientEnvironmentProvider environment={electronClientEnvironment(new URLSearchParams())}>
      <StatisticsActivity statistics={statistics} /><StatisticsSettings statistics={statistics} />
    </ClientEnvironmentProvider>);
    expect((await screen.findByRole("switch", { name: "Share usage statistics" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => statistics.record("human_prompt_accepted"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).not.toHaveBeenCalled();
    statistics.dispose();
  });

  it("asks once after a prompt, and an answer on this device ends the question", async () => {
    const environment = electronClientEnvironment(new URLSearchParams("clientRelease=0.7.39&clientPlatform=darwin"));
    const storage = createMemoryStorage();
    const send = vi.fn<SendActivity>(async () => undefined);
    const window = () => {
      const statistics = new UsageStatistics(storage, send, Date.now, () => "0123456789abcdef");
      const toasts: ToastOptions[] = [];
      const listeners = new Set<() => void>();
      const actions = { toast: (options: ToastOptions) => { toasts.push(options); return { id: options.id!, update: vi.fn(), dismiss: vi.fn() }; }, openSettings: vi.fn() };
      const view = render(<ClientEnvironmentProvider environment={environment}>
        <StatisticsActivity statistics={statistics} actions={actions} onPrompt={(listener) => { listeners.add(listener); return () => listeners.delete(listener); }} />
      </ClientEnvironmentProvider>);
      const prompt = () => act(() => listeners.forEach((listener) => listener()));
      return { statistics, toasts, actions, prompt, close: () => { view.unmount(); statistics.dispose(); } };
    };

    const first = window();
    first.prompt();
    first.prompt();
    expect(first.toasts).toEqual([expect.objectContaining({ type: "question", title: "Share usage statistics?", timeoutMs: 0 })]);
    first.toasts[0].actions!.find((action) => action.label === "Details")!.run();
    expect(first.actions.openSettings).toHaveBeenCalledWith("general#setting-share-usage-statistics");
    first.close();

    // Closed without an answer: the next window asks again.
    const second = window();
    second.prompt();
    expect(second.toasts).toHaveLength(1);
    act(() => second.toasts[0].actions!.find((action) => action.label === "Share")!.run());
    expect(second.statistics.getSnapshot().enabled).toBe(true);
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ event: "human_prompt_accepted" }), expect.anything()));
    second.close();

    const third = window();
    third.prompt();
    expect(third.toasts).toEqual([]);
    act(() => third.statistics.setEnabled(false));
    third.close();
    const fourth = window();
    fourth.prompt();
    expect(fourth.toasts).toEqual([]);
    fourth.close();
  });

  it("never asks in development and isolated instances", () => {
    const statistics = new UsageStatistics(createMemoryStorage());
    const toast = vi.fn();
    let prompt = () => {};
    render(<ClientEnvironmentProvider environment={electronClientEnvironment(new URLSearchParams())}>
      <StatisticsActivity statistics={statistics} actions={{ toast, openSettings: vi.fn() }} onPrompt={(listener) => { prompt = listener; return () => {}; }} />
    </ClientEnvironmentProvider>);
    act(() => prompt());
    expect(toast).not.toHaveBeenCalled();
    statistics.dispose();
  });
});
