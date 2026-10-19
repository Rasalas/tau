import { expect, it, vi } from "vitest";
import { NO_FONTS_MESSAGE, requireBrowserFonts } from "./browser-fonts.js";

it("only asks Linux, and says which packages to install when no font is found", async () => {
  const none = vi.fn(async () => "");
  await requireBrowserFonts("darwin", none);
  await requireBrowserFonts("win32", none);
  expect(none).not.toHaveBeenCalled();
  await expect(requireBrowserFonts("linux", none)).rejects.toThrow(NO_FONTS_MESSAGE);
  expect(NO_FONTS_MESSAGE).toMatch(/fontconfig.*fonts-liberation/u);
});

it("remembers a font once one was found", async () => {
  const found = vi.fn(async () => "/usr/share/fonts/liberation/LiberationSans-Regular.ttf");
  await requireBrowserFonts("linux", found);
  await requireBrowserFonts("linux", found);
  expect(found).toHaveBeenCalledTimes(1);
});
