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
    expect(getByLabelText("Claude Code provider").closest(".thread-meta-line")).toBeTruthy();
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
