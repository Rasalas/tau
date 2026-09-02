// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { ExtensionRegistry } from "../extension-system";
import { claudeCodeExtension } from "./claude-code-kit";

describe("Claude Code desktop extension", () => {
  it("marks Claude threads in the status line and stays silent for Pi", () => {
    const registry = new ExtensionRegistry();
    registry.activate(claudeCodeExtension);
    const [item] = registry.getStatusItems();
    expect(item?.id).toBe("claude-code.runtime");
    const actions = {} as never;
    const { rerender } = render(<item.Component snapshot={{ backendKind: "claude-code" } as HostSnapshot} actions={actions} />);
    expect(screen.getByText("Claude Code")).toBeTruthy();
    rerender(<item.Component snapshot={{ backendKind: "pi" } as HostSnapshot} actions={actions} />);
    expect(screen.queryByText("Claude Code")).toBeNull();
  });
});
