// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerNotice } from "./ComposerNotice";

afterEach(cleanup);

describe("ComposerNotice (2c)", () => {
  it("names a refused key and offers to replace it", () => {
    const onReplaceKey = vi.fn();
    const onSwitchModel = vi.fn();
    render(<ComposerNotice sessionId="s" error={'401 {"message":"Incorrect API key provided"}'} provider="openai" onReplaceKey={onReplaceKey} onSwitchModel={onSwitchModel} />);
    expect(screen.getByRole("status").textContent).toContain("OpenAI rejected the API key");
    expect(screen.getByRole("status").querySelector("p")?.textContent).toBe("401 · Incorrect API key provided");
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch model" }));
    expect(onReplaceKey).toHaveBeenCalledOnce();
    expect(onSwitchModel).toHaveBeenCalledOnce();
  });

  it("draws a rate limit in amber and retries on request", () => {
    const onRetry = vi.fn();
    const { container } = render(<ComposerNotice sessionId="s" error="429 Too Many Requests" onReplaceKey={() => undefined} onRetry={onRetry} />);
    expect(container.querySelector(".composer-notice.warn strong")?.textContent).toBe("Rate limit");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("says any other failure stopped the turn, without Retry on a read-only device", () => {
    const { container } = render(<ComposerNotice sessionId="s" error="stream disconnected" onReplaceKey={() => undefined} />);
    expect(container.querySelector(".composer-notice.fail strong")?.textContent).toBe("Stopped with an error");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
