// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { RetryMessageContext } from "../workbench-context";
import { UserMessage } from "./UserMessage";

afterEach(cleanup);
const message: UiMessage = { id: "local-one", role: "user", text: "Sent from the composer", timestamp: 1 };

describe("a submitted message's confirmation", () => {
  it("shows that a send is pending without claiming it was confirmed", () => {
    render(<UserMessage message={{ ...message, submission: { state: "sending" } }} />);
    expect(screen.getByRole("status").textContent).toBe("Sending…");
    expect(screen.queryByRole("img", { name: "Sent" })).toBeNull();
  });

  it("offers retry beside the unconfirmed message", () => {
    const retryMessage = vi.fn(async () => undefined);
    render(<RetryMessageContext.Provider value={retryMessage}>
      <UserMessage message={{ ...message, submission: { state: "failed", error: "Connection dropped" } }} />
    </RetryMessageContext.Provider>);
    expect(screen.getByRole("status").textContent).toBe("Delivery not confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryMessage).toHaveBeenCalledExactlyOnceWith("local-one");
  });
});
