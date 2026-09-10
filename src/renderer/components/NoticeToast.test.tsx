// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../workbench/client-storage";
import type { Platform } from "../../workbench/platform";
import { PlatformProvider } from "../platform-context";
import { NoticeToast } from "./NoticeToast";

afterEach(cleanup);

function platformWith(writeText: (text: string) => Promise<void>): Platform {
  return {
    clipboard: { writeText },
    openExternal: () => undefined,
    storage: createMemoryStorage(),
    importModule: async () => ({}),
  };
}

function renderToast(writeText = vi.fn(async () => undefined), overrides: Partial<{ level: "info" | "warning" | "error"; message: string }> = {}) {
  const onDismiss = vi.fn();
  const view = render(<PlatformProvider platform={platformWith(writeText)}>
    <NoticeToast level={overrides.level ?? "error"} message={overrides.message ?? "400: {\"type\":\"MissingSessionID\"}"} onDismiss={onDismiss} />
  </PlatformProvider>);
  return { onDismiss, view };
}

describe("NoticeToast", () => {
  it("names the level and shows the message it cannot read any better", () => {
    renderToast();
    expect(screen.getByRole("status").textContent).toContain("ERROR");
    expect(screen.getByRole("status").textContent).toContain("400: {\"type\":\"MissingSessionID\"}");
  });

  it("reads a provider payload as the sentence inside it and copies the payload", async () => {
    const writeText = vi.fn(async () => undefined);
    const payload = '400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session"}';
    renderToast(writeText, { message: payload });

    expect(screen.getByRole("status").textContent).toContain("400 · Request is missing x-opencode-session");
    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));
    expect(writeText).toHaveBeenCalledWith(payload);
  });

  it("copies the message, not the label, and confirms it", async () => {
    const writeText = vi.fn(async () => undefined);
    renderToast(writeText, { message: "http://127.0.0.1:1/very/long/url#fragment" });

    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));

    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:1/very/long/url#fragment");
    await screen.findByRole("button", { name: "Copied" });
  });

  it("stays a notice when the clipboard refuses", async () => {
    const writeText = vi.fn(async () => { throw new Error("denied"); });
    const { onDismiss } = renderToast(writeText);

    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Copy notice" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("400: {\"type\":\"MissingSessionID\"}");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("is dismissed by its own button and by nothing else", () => {
    const { onDismiss } = renderToast();

    fireEvent.click(screen.getByText("400: {\"type\":\"MissingSessionID\"}"));
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
