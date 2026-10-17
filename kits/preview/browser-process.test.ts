import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PreviewBrowserProcess } from "./browser-process.js";

it("rejects pending commands when the browser executable cannot start", async () => {
  const browser = new PreviewBrowserProcess(join(tmpdir(), `missing-browser-${randomUUID()}`), join(tmpdir(), "unused-preview-profile"));
  await expect(browser.send("Browser.getVersion")).rejects.toThrow(/could not start|pipe closed/u);
  await browser.exited;
  await expect(browser.send("Page.enable")).rejects.toThrow("closed");
  await browser.close();
});
