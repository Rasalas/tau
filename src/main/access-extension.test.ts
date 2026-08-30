import { describe, expect, it } from "vitest";
import { isMutatingToolCall } from "./access-extension.js";

describe("isMutatingToolCall", () => {
  it("keeps computer-use perception available in read-only threads", () => {
    expect(isMutatingToolCall("computer_use_get_window_state", {})).toBe(false);
    expect(isMutatingToolCall("computer_use_get_browser_state", {})).toBe(false);
    expect(isMutatingToolCall("computer_use_page", { action: "get_text" })).toBe(false);
    expect(isMutatingToolCall("computer_use_browser_dialog", { action: "inspect" })).toBe(false);
    expect(isMutatingToolCall("computer_use_check_permissions", { prompt: false })).toBe(false);
  });

  it("gates computer-use actions that can affect the desktop", () => {
    expect(isMutatingToolCall("computer_use_click", {})).toBe(true);
    expect(isMutatingToolCall("computer_use_type_text", {})).toBe(true);
    expect(isMutatingToolCall("computer_use_launch_app", {})).toBe(true);
    expect(isMutatingToolCall("computer_use_page", { action: "click_element" })).toBe(true);
    expect(isMutatingToolCall("computer_use_browser_dialog", { action: "accept" })).toBe(true);
    expect(isMutatingToolCall("computer_use_check_permissions", {})).toBe(true);
  });

  it("preserves the existing workspace mutation policy", () => {
    expect(isMutatingToolCall("read", {})).toBe(false);
    expect(isMutatingToolCall("edit", {})).toBe(true);
    expect(isMutatingToolCall("bash", {})).toBe(true);
  });
});
