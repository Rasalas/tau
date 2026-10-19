// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { sharePullRequestLink } from "./share-link.js";

const request = { url: "https://github.com/acme/app/pull/7", title: "PR #7 Add cards" };
const actions = () => ({ copyText: vi.fn(async () => undefined), notify: vi.fn() });
const setShare = (share: unknown, canShare?: unknown) => {
  Object.defineProperty(navigator, "share", { value: share, configurable: true });
  Object.defineProperty(navigator, "canShare", { value: canShare, configurable: true });
};
afterEach(() => setShare(undefined));

it("hands the link to the system share sheet where the Web Share API exists", async () => {
  const share = vi.fn(async () => undefined);
  setShare(share);
  const app = actions();
  await sharePullRequestLink(request, app);
  expect(share).toHaveBeenCalledWith({ url: request.url, title: request.title });
  expect(app.copyText).not.toHaveBeenCalled();
});

it("copies the link and says so where the WebView has no Web Share API", async () => {
  setShare(undefined);
  const app = actions();
  await sharePullRequestLink(request, app);
  expect(app.copyText).toHaveBeenCalledWith(request.url);
  expect(app.notify).toHaveBeenCalledWith("Sharing is not available here. Copied the link instead.");
});

it("copies when sharing this data is refused or fails, but not when the person closes the sheet", async () => {
  const app = actions();
  setShare(vi.fn(), () => false);
  await sharePullRequestLink(request, app);
  expect(app.copyText).toHaveBeenCalledTimes(1);
  setShare(vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }));
  await sharePullRequestLink(request, app);
  expect(app.copyText).toHaveBeenCalledTimes(2);
  setShare(vi.fn(async () => { throw new DOMException("closed", "AbortError"); }));
  await sharePullRequestLink(request, app);
  expect(app.copyText).toHaveBeenCalledTimes(2);
});
