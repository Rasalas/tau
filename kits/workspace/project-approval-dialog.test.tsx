// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RegionProps } from "tau";
import { createProjectApprovalDialog } from "./project-approval-dialog.js";
import { PROJECT_APPROVAL_EVENT, type ProjectApprovalRequest } from "../_project-file/setup-approval.js";

const request: ProjectApprovalRequest = { id: "approval-one", project: "/repo", commands: ["npm ci", "npm run build"] };
const props = { actions: { notify: vi.fn() } } as unknown as RegionProps;

describe("project setup approval dialog", () => {
  it.each([true, false])("shows the commands and answers with approval %s", async (approved) => {
    let push: (payload: unknown) => void = () => undefined;
    const invoke = vi.fn(async (command: string) => {
      if (command === "project-approvals") return [request];
      push([]);
      return undefined;
    });
    const Dialog = createProjectApprovalDialog({
      invoke,
      onEvent: (name, listener) => { expect(name).toBe(PROJECT_APPROVAL_EVENT); push = listener; return () => undefined; },
    });
    render(<Dialog {...props} />);
    expect((await screen.findByText("npm ci npm run build")).textContent).toBe("npm ci\n\nnpm run build");
    expect(screen.getByText("/repo/.tau/project.json")).toBeTruthy();
    const button = await screen.findByRole("button", { name: approved ? "Allow project setup" : "Skip setup" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("answer-project-approval", { id: request.id, approved }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps a new request when the initial list arrives late", async () => {
    let resolve!: (value: unknown) => void;
    let push!: (payload: unknown) => void;
    const Dialog = createProjectApprovalDialog({
      invoke: () => new Promise((done) => { resolve = done; }),
      onEvent: (_name, listener) => { push = listener; return () => undefined; },
    });
    render(<Dialog {...props} />);
    await act(async () => { push([request]); });
    expect((await screen.findByText("npm ci npm run build")).textContent).toBe("npm ci\n\nnpm run build");
    await act(async () => { resolve([]); });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
