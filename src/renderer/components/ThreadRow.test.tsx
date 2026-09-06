// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRow } from "./ThreadRow";

const session = {
  id: "thread",
  path: "/tmp/thread.jsonl",
  title: "Use project icon",
  modifiedAt: 1,
  projectPath: "/repos/tau",
  projectName: "tau",
  messageCount: 1,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ThreadRow project mark", () => {
  it("renders the detected project image", () => {
    const icon = "data:image/svg+xml;base64,aWNvbg==";
    const { container } = render(<ThreadRow
      activity="idle"
      active={false}
      age="now"
      projectIcon={icon}
      session={session}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);

    expect(container.querySelector<HTMLImageElement>(".thread-project-icon img")?.src).toBe(icon);
    expect(container.querySelector(".thread-project-icon")?.textContent).toBe("");
  });

  it("keeps the initial when no project image was found", () => {
    const { container } = render(<ThreadRow
      activity="idle"
      active={false}
      age="now"
      session={session}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);

    expect(container.querySelector(".thread-project-icon")?.textContent).toBe("T");
    expect(container.querySelector(".thread-project-icon img")).toBeNull();
  });

  it("moves live activity beside the project and leaves the provider mark below", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:01:05Z"));
    const { container, getByLabelText } = render(<ThreadRow
      activity="working"
      active
      age="now"
      session={{ ...session, modifiedAt: Date.parse("2026-09-01T12:00:00Z"), backendKind: "claude-code" }}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);

    expect(container.querySelector(".thread-project-line .thread-status-age")?.textContent).toBe("WORKING1:05");
    expect(container.querySelector(".thread-meta-line .thread-activity")).toBeNull();
    expect(getByLabelText("Claude Code").closest(".thread-meta-line")).toBeTruthy();
  });

  it("overlaps the model provider over its runtime", () => {
    const { container, getByLabelText } = render(<ThreadRow
      activity="idle"
      active={false}
      age="now"
      session={{ ...session, backendKind: "opencode", modelProvider: "google" }}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);

    const stack = getByLabelText("Google Gemini via OpenCode");
    expect(stack.classList).toContain("stacked");
    expect(container.querySelectorAll(".provider-icon")).toHaveLength(2);
    expect(container.querySelector(".provider-icon-runtime img")).toBeTruthy();
    expect(container.querySelector(".provider-icon-model img")).toBeTruthy();
  });

  it("does not replace WORKING with the active tool name", () => {
    const { container } = render(<ThreadRow
      activity="tool"
      activityLabel="BASH"
      active
      age="now"
      session={session}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);

    expect(container.querySelector(".thread-status-age")?.textContent).toMatch(/^WORKING/u);
    expect(container.textContent).not.toContain("BASH");
  });

  it("shows only actionable idle-state labels", () => {
    const idle = render(<ThreadRow
      activity="idle"
      active={false}
      age="now"
      session={session}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);
    expect(idle.container.textContent).not.toContain("IDLE");
    idle.unmount();

    const ready = render(<ThreadRow
      activity="ready"
      active={false}
      age="now"
      session={session}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);
    expect(ready.container.querySelector(".thread-status-age")?.textContent).toBe("READY");
  });
});

describe("ThreadRow cost", () => {
  const usage = {
    inputTokens: 12_300, outputTokens: 2_100, cacheReadTokens: 8_000, cacheWriteTokens: 0,
    totalTokens: 22_400, costUsd: 0.4231, turns: 3,
  };

  it("puts the cost in the meta line, with the split as its title", () => {
    const { container } = render(<ThreadRow
      activity="idle"
      active={false}
      age="now"
      showCost
      session={{ ...session, usage }}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);

    const cost = container.querySelector(".thread-meta-line .thread-cost-meta");
    expect(cost?.textContent).toBe("$0.42");
    expect(cost?.getAttribute("title")).toBe("12.3k in · 2.1k out · 8.0k cache read · 3 turns");
  });

  it("leaves the row alone when costs are hidden or unknown", () => {
    const hidden = render(<ThreadRow
      activity="idle" active={false} age="now" session={{ ...session, usage }}
      onSelect={() => {}} onToggleSettled={() => {}}
    />);
    expect(hidden.container.querySelector(".thread-cost-meta")).toBeNull();
    cleanup();

    const unknown = render(<ThreadRow
      activity="idle" active={false} age="now" showCost session={session}
      onSelect={() => {}} onToggleSettled={() => {}}
    />);
    expect(unknown.container.querySelector(".thread-cost-meta")).toBeNull();
  });
});
