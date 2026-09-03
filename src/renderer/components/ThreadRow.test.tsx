// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(cleanup);

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
});
