// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceResources } from "../workspace-resource-context";
import { Markdown } from "./Markdown";

const fixture = vi.hoisted(() => ({ resources: undefined as WorkspaceResources | undefined }));
vi.mock("../workspace-resource-context", async (load) => ({ ...await load<typeof import("../workspace-resource-context")>(), useWorkspaceResources: () => fixture.resources }));
afterEach(() => { cleanup(); fixture.resources = undefined; });

const LINK = String.raw`[shot](C:\me\.t3\shot.png)`;

describe("Windows drive path links", () => {
  it("open the file with the path as written", () => {
    const openFile = vi.fn();
    fixture.resources = { available: true, displayPath: "C:/other", loadFile: vi.fn(), openFile };
    render(<Markdown>{LINK}</Markdown>);
    screen.getByText("shot").click();
    expect(openFile).toHaveBeenCalledWith("C:/me/.t3/shot.png");
  });

  it("stay plain text without a workspace, never a link the browser reads as a scheme", () => {
    const { container } = render(<Markdown>{LINK}</Markdown>);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("shot");
  });
});
