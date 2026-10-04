// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RegionProps } from "tau";
import { RequestLinks } from "./request-links.js";
import { PULL_REQUEST_TAB } from "./protocol.js";

afterEach(cleanup);
const url = "https://github.com/acme/tau/pull/42";
function draw(badge = false, href = url) {
  const openStageTab = vi.fn(() => "tab");
  const openExternal = vi.fn();
  const selectThread = vi.fn((event: import("react").MouseEvent) => event.preventDefault());
  const actions = { openStageTab, openExternal, activeThread: () => ({ cwd: "/active" }) } as unknown as RegionProps["actions"];
  const view = render(<><RequestLinks actions={actions} /><div className={badge ? "thread-row" : "message"} onClick={selectThread}><div className={badge ? "thread-accessory" : "markdown"}>
    <a href={href} className={badge ? "request-badge" : undefined} data-request-workspace={badge ? "/other" : undefined}><span>#42</span></a>
  </div></div></>);
  return { openStageTab, openExternal, selectThread, ...view };
}

it.each([false, true])("opens a request in Tau without selecting its thread, badge=%s", (badge) => {
  const { openStageTab, openExternal, selectThread } = draw(badge);
  fireEvent.click(screen.getByText("#42"));
  expect(openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, expect.objectContaining({ url, number: 42, service: "github", workspace: badge ? "/other" : "/active" }), { key: url });
  expect(openExternal).not.toHaveBeenCalled();
  expect(selectThread).not.toHaveBeenCalled();
});
it.each(["metaKey", "ctrlKey"])("opens the browser with %s", (modifier) => {
  const { openStageTab, openExternal } = draw();
  fireEvent.click(screen.getByText("#42"), { [modifier]: true });
  expect(openExternal).toHaveBeenCalledWith(url);
  expect(openStageTab).not.toHaveBeenCalled();
});
it("leaves unrelated links alone", () => {
  const { openStageTab, openExternal, selectThread } = draw(false, "https://github.com/acme/tau/issues/42");
  fireEvent.click(screen.getByText("#42"));
  expect(openStageTab).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
  expect(selectThread).toHaveBeenCalled();
});
it("removes its routing listener on unmount", () => {
  const { openStageTab, unmount } = draw();
  unmount();
  const message = document.createElement("div");
  message.className = "message";
  message.innerHTML = `<div class="markdown"><a href="${url}">#42</a></div>`;
  document.body.append(message);
  message.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(message.querySelector("a")!);
  expect(openStageTab).not.toHaveBeenCalled();
  message.remove();
});
