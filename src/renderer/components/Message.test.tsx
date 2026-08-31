// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiComposerCommand } from "../../shared/contracts";
import { localImagePaths, Message, withoutLocalImagePaths } from "./Message";

afterEach(cleanup);

describe("Message images", () => {
  it("finds shell-escaped local image paths", () => {
    const text = "/Users/me/Application\\ Support/CleanShot/image.png please inspect";
    expect(localImagePaths(text)).toEqual(["/Users/me/Application Support/CleanShot/image.png"]);
    expect(withoutLocalImagePaths(text)).toBe("please inspect");
  });

  it("renders image content persisted in the Pi message", () => {
    render(<Message message={{
      id: "user-image",
      role: "user",
      text: "please inspect",
      images: [{ mimeType: "image/png", data: "iVBORw==" }],
      timestamp: 0,
    }} />);

    const image = screen.getByRole("img", { name: "Attached image" }) as HTMLImageElement;
    expect(image.src).toBe("data:image/png;base64,iVBORw==");
  });
});

describe("Message actions", () => {
  it("copies and forks a persisted message", () => {
    const onCopy = vi.fn();
    const onFork = vi.fn();
    const message = { id: "message", sourceEntryId: "entry", role: "assistant" as const, text: "Answer", timestamp: 0 };
    render(<Message message={message} onCopy={onCopy} onFork={onFork} />);

    fireEvent.click(screen.getByTitle("Copy message"));
    fireEvent.click(screen.getByTitle("Fork through this message"));
    expect(onCopy).toHaveBeenCalledWith(message);
    expect(onFork).toHaveBeenCalledWith(message);
  });

  it("does not offer a fork for an optimistic message", () => {
    render(<Message
      message={{ id: "local", role: "user", text: "Pending", timestamp: 0 }}
      onCopy={() => {}}
      onFork={() => {}}
    />);
    expect(screen.queryByTitle("Fork through this message")).toBeNull();
  });
});

describe("Message reasoning presentation", () => {
  it("keeps provider reasoning summaries out of the transcript", () => {
    const view = render(<Message message={{
      id: "assistant",
      role: "assistant",
      text: "Visible answer",
      thinking: "Internal reasoning summary",
      timestamp: 0,
    }} />);

    expect(screen.getByText("Visible answer")).toBeTruthy();
    expect(screen.queryByText("Internal reasoning summary")).toBeNull();
    expect(view.container.textContent).not.toContain("thinking");
  });

  it("does not render an empty thinking placeholder", () => {
    const view = render(<Message message={{ id: "working", role: "assistant", text: "", timestamp: 0 }} />);
    expect(view.container.textContent).toBe("");
  });
});

describe("Message async activity", () => {
  it("collapses subagent completion payloads behind a compact activity row", () => {
    const payload = 'Background task completed: **workflow** Workflow completed with 2 child run(s). Return: [{"key":"review","output":"large payload"}]';
    render(<Message message={{ id: "activity", role: "user", text: payload, timestamp: 0 }} />);

    expect(screen.getByText("2 subagent runs completed")).toBeTruthy();
    expect(screen.queryByText(/large payload/)).toBeNull();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/large payload/)).toBeTruthy();
  });

  it("collapses subagent attention notices", () => {
    const payload = "Subagent needs attention: reviewer Run: abc Signal: reviewer has had tool grep open for 240s";
    render(<Message message={{ id: "attention", role: "user", text: payload, timestamp: 0 }} />);

    expect(screen.getByText("Subagent needs attention")).toBeTruthy();
    expect(screen.queryByText(/tool grep open/)).toBeNull();
  });
});

describe("Message skill invocations", () => {
  const skillCommands: UiComposerCommand[] = [
    { name: "skill:tdd", source: "skill", description: "Build features test-first" },
  ];
  const envelope = `<skill name="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">
References are relative to /Users/me/.pi/skills/tdd.

Injected skill content that is not the user's request.
</skill>

Please fix **the parser** and keep the examples.`;

  it("renders a labelled skill chip and only the user's Markdown instruction", () => {
    const view = render(<Message
      message={{ id: "skill", role: "user", text: envelope, timestamp: 0 }}
      skillCommands={skillCommands}
    />);

    expect(screen.getByRole("img", { name: "Skill tdd" })).toBeTruthy();
    expect(screen.getByText("Skill")).toBeTruthy();
    expect(view.container.textContent).toContain("Please fix the parser and keep the examples.");
    expect(view.container.querySelector(".markdown strong")?.textContent).toBe("the parser");
    expect(view.container.textContent).not.toContain("Injected skill content");
    expect(view.container.textContent).not.toContain("References are relative");
    expect(view.container.textContent).not.toContain("/Users/me/.pi/skills");
  });

  it("recognizes a known direct invocation without hiding its instruction", () => {
    const view = render(<Message
      message={{ id: "skill-reference", role: "user", text: "/tdd **this change**", timestamp: 0 }}
      skillCommands={skillCommands}
    />);
    expect(screen.getByRole("img", { name: "Skill tdd" })).toBeTruthy();
    expect(view.container.textContent).toContain("this change");
    expect(view.container.querySelector(".markdown strong")?.textContent).toBe("this change");
  });

  it("leaves malformed and fenced lookalikes visible as ordinary Markdown", () => {
    const unknown = envelope.replace('name="tdd"', 'name="missing"');
    const unknownView = render(<Message
      message={{ id: "unknown", role: "user", text: unknown, timestamp: 0 }}
      skillCommands={skillCommands}
    />);
    expect(unknownView.container.querySelector(".skill-chip")).toBeNull();
    expect(unknownView.container.textContent).toContain("<skill");
    expect(unknownView.container.textContent).toContain("Injected skill content");
    cleanup();

    const malformed = envelope.replace("</skill>", "</skill");
    const malformedView = render(<Message
      message={{ id: "malformed", role: "user", text: malformed, timestamp: 0 }}
      skillCommands={skillCommands}
    />);
    expect(malformedView.container.querySelector(".skill-chip")).toBeNull();
    expect(malformedView.container.textContent).toContain("<skill");
    expect(malformedView.container.textContent).toContain("Injected skill content");
    cleanup();

    const fenced = `\`\`\`xml\n${envelope}\n\`\`\``;
    const fencedView = render(<Message
      message={{ id: "fenced", role: "user", text: fenced, timestamp: 0 }}
      skillCommands={skillCommands}
    />);
    expect(fencedView.container.querySelector(".skill-chip")).toBeNull();
    expect(fencedView.container.textContent).toContain("Injected skill content");
  });
});
