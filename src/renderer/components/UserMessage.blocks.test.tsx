// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { ExtensionRegistry, type MessageBlockProps, type WorkbenchActions } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { Message } from "./Message";

afterEach(cleanup);

function Card({ body }: MessageBlockProps) {
  return <section aria-label="Context card">{body}</section>;
}

function renderWith(message: UiMessage, roles?: readonly ("user" | "assistant")[]) {
  const registry = new ExtensionRegistry();
  registry.activate({
    id: "test.blocks",
    name: "Blocks",
    activate(context) { context.registerMessageBlock({ id: "context", tag: "context_note", ...(roles ? { roles } : {}), Component: Card }); },
  });
  return render(
    <WorkbenchShellContext.Provider value={{ registry, actions: {} as WorkbenchActions }}>
      <Message message={message} />
    </WorkbenchShellContext.Provider>,
  );
}

const prompt: UiMessage = { id: "u1", role: "user", text: "<context_note>\nWhat the other thread did.\n</context_note>\n\nNow continue.", timestamp: 1 };

describe("message blocks in a user message", () => {
  it("draws a block that asks for user messages above the bubble and keeps it out of the text", () => {
    const view = renderWith(prompt, ["user"]);
    expect(screen.getByRole("region", { name: "Context card" }).textContent).toBe("What the other thread did.");
    expect(view.container.querySelector(".message-user-blocks")).not.toBeNull();
    expect(view.container.querySelector(".message-text-content")?.textContent).toBe("Now continue.");
  });

  it("leaves a user message alone for a block that only draws in replies", () => {
    const view = renderWith(prompt);
    expect(screen.queryByRole("region", { name: "Context card" })).toBeNull();
    expect(view.container.querySelector(".message-text-content")?.textContent).toContain("What the other thread did.");
  });

  it("keeps an assistant reply's block out of a user-only contribution", () => {
    renderWith({ ...prompt, id: "a1", role: "assistant" }, ["user"]);
    expect(screen.queryByRole("region", { name: "Context card" })).toBeNull();
  });
});
