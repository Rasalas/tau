// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

    expect(container.querySelector(".thread-project-line .thread-status-age")?.textContent).toBe("Working1:05");
    expect(container.querySelector(".thread-meta-line .thread-activity")).toBeNull();
    expect(getByLabelText("Claude Code").closest(".thread-meta-line")).toBeTruthy();
  });

  it("badges the provider's mark with its runtime's", () => {
    const { container, getByLabelText } = render(<ThreadRow
      activity="idle"
      active={false}
      age="now"
      session={{ ...session, backendKind: "opencode", modelProvider: "google" }}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);

    const stack = getByLabelText("OpenCode via Google Gemini");
    expect(stack.classList).toContain("stacked");
    expect(container.querySelectorAll(".provider-icon")).toHaveLength(2);
    expect(container.querySelector(".provider-icon-runtime .provider-mark")).toBeTruthy();
    expect(container.querySelector(".provider-icon-model .provider-mark")).toBeTruthy();
  });

  it("does not replace the Working label with the active tool name", () => {
    const { container } = render(<ThreadRow
      activity="tool"
      activityLabel="BASH"
      active
      age="now"
      session={session}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);

    expect(container.querySelector(".thread-status-age")?.textContent).toMatch(/^Working/u);
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
    expect(idle.container.textContent).not.toContain("Idle");
    idle.unmount();

    const ready = render(<ThreadRow
      activity="ready"
      active={false}
      age="now"
      session={session}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);
    expect(ready.container.querySelector(".thread-status-age")?.textContent).toBe("Ready");
  });

  it("says a thread failed, with the reason on the badge", () => {
    const { container } = render(<ThreadRow
      activity="failed"
      activityLabel="Failed"
      activityHint="stream disconnected"
      active={false}
      age="now"
      session={session}
      onSelect={() => {}}
      onToggleSettled={() => {}}
    />);
    const badge = container.querySelector(".thread-status-age.status-failed");
    expect(badge?.textContent).toBe("Failed");
    expect(badge?.querySelector("svg")).toBeTruthy();
    expect(badge?.getAttribute("data-tooltip")).toBe("stream disconnected");
  });
});

describe("ThreadRow state and type", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "styles.css"), "utf8");
  const rule = (selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";

  it("marks a question with a help glyph and a finished run with a check", () => {
    const waiting = render(<ThreadRow activity="waiting" activityLabel="Needs you" active={false} age="now" session={session} onSelect={() => {}} />);
    const question = waiting.container.querySelector(".thread-status-age.status-waiting");
    expect(question?.textContent).toBe("Needs you");
    expect(question?.querySelector("svg.lucide-circle-help, svg.lucide-circle-question-mark")).toBeTruthy();
    waiting.unmount();
    const ready = render(<ThreadRow activity="ready" active={false} age="now" session={session} onSelect={() => {}} />);
    expect(ready.container.querySelector(".thread-status-age.status-ready svg.lucide-check")).toBeTruthy();
  });

  it("colours the states as one triplet: a run blue, a question amber, done green", () => {
    expect(rule(".thread-status-age")).toMatch(/color: var\(--info-ink\)/u);
    expect(rule(".thread-status-age > i")).toMatch(/var\(--info\)/u);
    expect(rule(".thread-status-age.status-waiting")).toMatch(/color: var\(--warn\)/u);
    expect(rule(".thread-status-age.status-ready")).toMatch(/color: var\(--ready\)/u);
  });

  it("sets titles in regular type and only the open thread's in semibold", () => {
    expect(rule(".thread-title")).toMatch(/font-weight: 400/u);
    expect(rule(".thread-row.active .thread-title")).toMatch(/font-weight: 600/u);
  });

  it("leads the branch with a branch glyph, in the row's sans face", () => {
    const { container } = render(<ThreadRow activity="idle" active={false} age="now" session={{ ...session, projectLabel: "fix/pairing-flake" }} onSelect={() => {}} />);
    const branch = container.querySelector(".thread-branch")!;
    expect(branch.firstElementChild?.matches("svg.lucide-git-branch")).toBe(true);
    expect(branch.getAttribute("aria-hidden")).toBeNull();
    expect(rule(".thread-branch")).toMatch(/var\(--sans\)/u);
  });
});

describe("ThreadRow cost", () => {
  const usage = {
    inputTokens: 12_300, outputTokens: 2_100, cacheReadTokens: 8_000, cacheWriteTokens: 0,
    totalTokens: 22_400, costUsd: 0.4231, turns: 3,
  };

  it("puts the cost in the meta line, with where it comes from and the split as its title", () => {
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
    expect(cost?.getAttribute("data-tooltip")).toBe("Billed via the API · 12.3k in · 2.1k out · 8.0k cache read · 3 turns");
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

describe("ThreadRow accessory", () => {
  it("draws a kit's mark in both the full and the compact row", () => {
    for (const compact of [false, true]) {
      const { container, unmount } = render(<ThreadRow
        activity="idle"
        active={false}
        age="now"
        compact={compact}
        session={{ ...session, projectLabel: "feature/pr" }}
        accessory={<span className="kit-mark">PR #4</span>}
        onSelect={() => {}}
        onToggleSettled={() => {}}
      />);
      expect(container.querySelector(".kit-mark")?.textContent).toBe("PR #4");
      unmount();
    }
  });
});

describe("ThreadRow hover actions and label", () => {
  it("puts a caller's actions before Settle, and none on a settled row", () => {
    const { container, unmount } = render(<ThreadRow
      activity="idle" active={false} age="now" session={session}
      actions={<button type="button" aria-label="Snooze thread" />}
      onSelect={() => {}} onToggleSettled={() => {}}
    />);
    const buttons = [...container.querySelectorAll(".thread-row-actions > button")].map((button) => button.getAttribute("aria-label"));
    expect(buttons).toEqual(["Snooze thread", "Settle Use project icon"]);
    unmount();

    const settled = render(<ThreadRow
      activity="settled" active={false} age="now" session={session}
      actions={<button type="button" aria-label="Snooze thread" />}
      onSelect={() => {}} onToggleSettled={() => {}}
    />);
    expect(settled.container.querySelector("[aria-label='Snooze thread']")).toBeNull();
  });

  it("marks another machine's thread just before the cost, and offers no Settle without a handler", () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0.5, turns: 1 };
    const { container } = render(<ThreadRow
      activity="idle" active={false} age="now" showCost session={{ ...session, usage }}
      machine={{ name: "rex", icon: <svg /> }}
      onSelect={() => {}}
    />);
    const mark = container.querySelector(".thread-meta-line .thread-machine");
    expect(mark?.getAttribute("aria-label")).toBe("On rex");
    expect(mark?.getAttribute("data-tooltip")).toBe("rex");
    expect(mark?.nextElementSibling?.classList.contains("thread-cost-meta")).toBe(true);
    expect(container.querySelector(".thread-settle")).toBeNull();
  });

  it("never lets the meta line run out of a narrow card: what yields first comes last, the provider mark stays", () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 120.14, turns: 1 };
    const { container } = render(<ThreadRow
      activity="idle" active={false} age="now" showCost workingChildren={2}
      session={{ ...session, usage, projectLabel: "feat/meta-line", backendKind: "claude-code", modelProvider: "anthropic" }}
      machine={{ name: "rex", icon: <svg /> }}
      accessory={<span className="request-badge">+2</span>}
      onSelect={() => {}}
    />);
    // Drawn right to left and wrapped into a clipped line: the first child is the last to go.
    const parts = [...container.querySelector(".thread-meta-line")!.children].map((child) => child.className.split(" ")[0]);
    expect(parts).toEqual(["thread-meta-end", "thread-meta-marks", "thread-branch", "thread-agent-count"]);
    const end = [...container.querySelector(".thread-meta-end")!.children].map((child) => child.className.split(" ")[0]);
    expect(end).toEqual(["thread-machine", "thread-cost-meta", "provider-icon-stack"]);
    // jsdom lays nothing out, so the rule that does is read from the stylesheet itself.
    const css = readFileSync(join(import.meta.dirname, "..", "styles.css"), "utf8");
    const rule = /\.thread-meta-line \{([^}]*)\}/u.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/flex-flow: row-reverse wrap/u);
    expect(rule).toMatch(/overflow: hidden/u);
    expect(/\.thread-meta-end \{([^}]*)\}/u.exec(css)?.[1]).toMatch(/min-width: 0/u);
    expect(/\.thread-cost-meta \{([^}]*)\}/u.exec(css)?.[1]).toMatch(/text-overflow: ellipsis/u);
  });

  it("leaves the label line out when the caller says it tells nothing", () => {
    const shown = render(<ThreadRow activity="idle" active={false} age="now" session={{ ...session, projectLabel: "feature/x" }} onSelect={() => {}} onToggleSettled={() => {}} />);
    expect(shown.container.querySelector(".thread-branch")?.textContent).toBe("feature/x");
    shown.unmount();
    const hidden = render(<ThreadRow activity="idle" active={false} age="now" showLabel={false} session={{ ...session, projectLabel: "main" }} onSelect={() => {}} onToggleSettled={() => {}} />);
    expect(hidden.container.querySelector(".thread-branch")).toBeNull();
  });
});
