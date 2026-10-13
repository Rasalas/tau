// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "../../workbench/host-client";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { AccessKeyRow } from "./AccessKeyRow";

afterEach(cleanup);

const KEY = "3f9c".repeat(16);

function setup(overrides: Partial<HostClient> = {}) {
  const hostToken = vi.fn(async () => KEY);
  const copyText = vi.fn(async (_text: string) => undefined);
  const onNotify = vi.fn();
  const view = render(
    <TestProviders><HostClientProvider client={createFakeHostClient({ hostToken, copyText, ...overrides })}><AccessKeyRow onNotify={onNotify} /></HostClientProvider></TestProviders>,
  );
  return { hostToken, copyText, onNotify, ...view };
}

/** A button that waits for the host's answer is clicked once it can be. */
async function ready(name: string): Promise<HTMLButtonElement> {
  const button = screen.getByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

describe("Settings → Connections → This machine → Access key", () => {
  it("is hidden until asked for, and says whom to give it to", () => {
    const { hostToken, container } = setup();
    expect(screen.getByText("Access key")).toBeTruthy();
    expect(screen.getByText(/Whoever has it can use this machine as you do\. Enter it only on your own devices or browsers\./u)).toBeTruthy();
    expect(container.textContent).not.toContain(KEY);
    // The page is not the place the key is read.
    expect(hostToken).not.toHaveBeenCalled();
  });

  it("shows the key on Show and hides it again, forgetting it", async () => {
    const { hostToken, container } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Show the access key" }));
    expect(await screen.findByText(KEY)).toBeTruthy();
    fireEvent.click(await ready("Hide the access key"));
    await waitFor(() => expect(container.textContent).not.toContain(KEY));
    // Shown again, the host is asked again: the page kept nothing.
    fireEvent.click(await ready("Show the access key"));
    expect(await screen.findByText(KEY)).toBeTruthy();
    expect(hostToken).toHaveBeenCalledTimes(2);
  });

  it("copies the key without showing it", async () => {
    const { copyText, onNotify, container, hostToken } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Copy the access key" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(KEY));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("Access key copied"));
    await ready("Copy the access key");
    expect(container.textContent).not.toContain(KEY);
    // The notice names the key's copy, never the key.
    expect(JSON.stringify(onNotify.mock.calls)).not.toContain(KEY);
    expect(hostToken).toHaveBeenCalledOnce();
  });

  it("copies the key it shows without asking the host again", async () => {
    const { copyText, hostToken } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Show the access key" }));
    await screen.findByText(KEY);
    fireEvent.click(await ready("Copy the access key"));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(KEY));
    expect(hostToken).toHaveBeenCalledOnce();
    expect(screen.getByText(KEY)).toBeTruthy();
  });

  it("says so when the machine's Tau is too old to show it, and stays hidden", async () => {
    const hostToken = vi.fn(async (): Promise<string> => { throw Object.assign(new Error("Unknown method"), { code: "unknown-method" }); });
    const { onNotify, container } = setup({ hostToken });
    fireEvent.click(screen.getByRole("button", { name: "Show the access key" }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("This machine's Tau is older and cannot show its access key. Update it first.", "error"));
    await ready("Show the access key");
    expect(container.textContent).not.toContain(KEY);
  });

  it("reports a copy that failed, and still hides the key", async () => {
    const copyText = vi.fn(async (_text: string): Promise<void> => { throw new Error("The clipboard is not available."); });
    const { onNotify, container } = setup({ copyText });
    fireEvent.click(screen.getByRole("button", { name: "Copy the access key" }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("The clipboard is not available.", "error"));
    await ready("Copy the access key");
    expect(container.textContent).not.toContain(KEY);
  });

  it("does not appear for a connection that is not the owner's", () => {
    const { hostToken, container } = setup({ isOwner: () => false });
    expect(container.textContent).toBe("");
    expect(hostToken).not.toHaveBeenCalled();
  });
});
