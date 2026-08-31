// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Message } from "./Message";
import { visibleUserMessageText } from "./MessageText";

afterEach(cleanup);

describe("Long user messages", () => {
  const message = (text: string) => ({ id: "long", role: "user" as const, text, timestamp: 0 });

  it("starts long messages collapsed and toggles the complete content", () => {
    const text = Array.from({ length: 10 }, (_, index) => `Line ${index + 1}`).join("\n");
    const view = render(<Message message={message(text)} />);

    const content = view.container.querySelector(".message-text-content") as HTMLElement;
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content.getAttribute("data-collapsed")).toBe("true");
    expect(content.className).toContain("collapsed");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    expect(content.getAttribute("data-collapsed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getByRole("button", { name: "Show more" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the transcript scroll position when toggled", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflow = "auto";
    scrollContainer.scrollTop = 240;
    document.body.append(scrollContainer);
    render(<Message message={message("x".repeat(601))} />, { container: scrollContainer });

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(scrollContainer.scrollTop).toBe(240);
  });

  it("passes the full message to copy while the preview is collapsed", () => {
    const onCopy = vi.fn();
    const longText = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join("\n");
    const fullMessage = message(longText);
    render(<Message message={fullMessage} onCopy={onCopy} />);

    fireEvent.click(screen.getByTitle("Copy message"));
    expect(onCopy).toHaveBeenCalledWith(fullMessage);
  });

  it("copies visible user text without local image path wrappers", () => {
    const onCopy = vi.fn();
    const fullMessage = message(`/tmp/CleanShot/image.png\n${Array.from({ length: 9 }, (_, index) => `Caption ${index + 1}`).join("\n")}`);
    render(<Message message={fullMessage} onCopy={onCopy} />);

    expect(visibleUserMessageText(fullMessage.text)).toContain("Caption 1");
    fireEvent.click(screen.getByTitle("Copy message"));
    expect(onCopy).toHaveBeenCalledWith({ ...fullMessage, text: Array.from({ length: 9 }, (_, index) => `Caption ${index + 1}`).join("\n") });
    expect(onCopy.mock.calls[0][0].text).not.toContain("/tmp/CleanShot/image.png");
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
  it("renders host-provided skill metadata and only the user's Markdown instruction", () => {
    const view = render(<Message
      message={{
        id: "skill",
        role: "user",
        text: "Please fix **the parser** and keep the examples.",
        skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd Please fix **the parser** and keep the examples." },
        timestamp: 0,
      }}
    />);

    expect(screen.getByRole("img", { name: "Skill tdd" })).toBeTruthy();
    expect(screen.getByText("Skill")).toBeTruthy();
    expect(view.container.querySelector(".skill-chip + .markdown.markdown-inline")).toBeTruthy();
    expect(view.container.querySelector(".skill-chip + .markdown")?.tagName).toBe("SPAN");
    expect(view.container.textContent).toContain("Please fix the parser and keep the examples.");
    expect(view.container.querySelector(".markdown strong")?.textContent).toBe("the parser");
    expect(view.container.textContent).not.toContain("Injected skill content");
    expect(view.container.textContent).not.toContain("References are relative");
    expect(view.container.textContent).not.toContain("/Users/me/.pi/skills");
  });

  it("keeps typed skill metadata authoritative over activity text heuristics", () => {
    render(<Message message={{
      id: "skill-activity-shaped",
      role: "user",
      text: "Background task completed: inspect the parser",
      skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd Background task completed: inspect the parser" },
      timestamp: 0,
    }} />);

    expect(screen.getByRole("img", { name: "Skill tdd" })).toBeTruthy();
    expect(screen.getByText("Background task completed: inspect the parser")).toBeTruthy();
  });

  it("preserves indentation and fenced Markdown in the host-provided text", () => {
    const instruction = "Review this:\n    keep this indentation\n\n```md\n  keep this fence\n```";
    expect(visibleUserMessageText(instruction)).toBe(instruction);
    const view = render(<Message
      message={{
        id: "skill-markdown",
        role: "user",
        text: instruction,
        skill: { name: "tdd", command: "/skill:tdd", copyText: `/skill:tdd ${instruction}` },
        timestamp: 0,
      }}
    />);
    expect(screen.getByRole("img", { name: "Skill tdd" })).toBeTruthy();
    expect(view.container.textContent).toContain("keep this indentation");
    expect(view.container.textContent).toContain("keep this fence");
    expect(view.container.querySelector("pre")).toBeTruthy();
    expect(view.container.querySelector(".markdown-inline")).toBeNull();
  });

  it("keeps a one-column GFM table outside the inline chip span", () => {
    const view = render(<Message
      message={{
        id: "skill-table",
        role: "user",
        text: "| skill |\n| --- |\n| tdd |",
        skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd | skill |\n| --- |\n| tdd |" },
        timestamp: 0,
      }}
    />);

    const table = view.container.querySelector("table");
    expect(table).toBeTruthy();
    expect(table?.closest("span")).toBeNull();
    expect(view.container.querySelector(".markdown-inline")).toBeNull();
  });

  it.each(["dark", "light"])("keeps the icon and text label available in the %s theme", (theme) => {
    document.documentElement.dataset.theme = theme;
    render(<Message message={{
      id: `skill-${theme}`,
      role: "user",
      text: "Continue the implementation",
      skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd Continue the implementation" },
      timestamp: 0,
    }} />);

    expect(screen.getByRole("img", { name: "Skill tdd" })).toBeTruthy();
    expect(screen.getByText("Skill")).toBeTruthy();
    expect(screen.getByText("tdd")).toBeTruthy();
    cleanup();
    delete document.documentElement.dataset.theme;
  });

  it("keeps skill copy keyboard-accessible while exposing a non-color label", () => {
    const onCopy = vi.fn();
    render(<Message message={{
      id: "skill-copy",
      role: "user",
      text: "Fix the parser",
      skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd Fix the parser" },
      timestamp: 0,
    }} onCopy={onCopy} />);

    const chip = screen.getByRole("img", { name: "Skill tdd" });
    expect(chip.textContent).toContain("Skill");
    const copy = screen.getByRole("button", { name: "Copy" });
    copy.focus();
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: "Enter" });
    fireEvent.click(copy);
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("leaves malformed and fenced lookalikes visible as ordinary Markdown", () => {
    const unknown = `<skill name="missing" location="/Users/me/.pi/skills/missing/SKILL.md">\nInjected skill content\n</skill>\n\nPlease keep this raw.`;
    const unknownView = render(<Message
      message={{ id: "unknown", role: "user", text: unknown, timestamp: 0 }}
    />);
    expect(unknownView.container.querySelector(".skill-chip")).toBeNull();
    expect(unknownView.container.textContent).toContain("<skill");
    expect(unknownView.container.textContent).toContain("Injected skill content");
    cleanup();

    const malformed = unknown.replace("</skill>", "</skill");
    const malformedView = render(<Message
      message={{ id: "malformed", role: "user", text: malformed, timestamp: 0 }}
    />);
    expect(malformedView.container.querySelector(".skill-chip")).toBeNull();
    expect(malformedView.container.textContent).toContain("<skill");
    expect(malformedView.container.textContent).toContain("Injected skill content");
    cleanup();

    const fenced = `\`\`\`xml\n${unknown}\n\`\`\``;
    const fencedView = render(<Message
      message={{ id: "fenced", role: "user", text: fenced, timestamp: 0 }}
    />);
    expect(fencedView.container.querySelector(".skill-chip")).toBeNull();
    expect(fencedView.container.textContent).toContain("Injected skill content");
  });
});
