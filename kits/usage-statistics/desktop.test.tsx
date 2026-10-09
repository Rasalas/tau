// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEnvironmentProvider, createMemoryStorage, electronClientEnvironment } from "../../src/renderer/test-support/kit-harness.js";
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
});
