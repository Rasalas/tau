import { describe, expect, it, vi } from "vitest";
import { PreferencesStore } from "../../src/renderer/test-support/kit-harness.js";
import type { PiProviderView } from "./protocol.js";
import { publishProviderIcons, readProviderIcon, RECHECK_MISSING_MS, syncSiteIcons, wantsSiteIcon, writeProviderIcon, type ProviderIconChoice, type SiteIconSync } from "./provider-icons.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const provider = (id: string, extra: Partial<PiProviderView> = {}): PiProviderView => ({ id, name: id, configured: true, site: `${id}.example`, ...extra });

describe("provider icons in the kit's values", () => {
  it("reads back pictures only as PNG, and the user's choices", () => {
    const values = new Map<string, string>();
    const preferences = { value: (_id: string, key: string) => values.get(key), setValue: (_id: string, key: string, value: string) => { values.set(key, value); } };
    writeProviderIcon(preferences, "radius", { kind: "upload", image: PNG });
    expect(readProviderIcon(preferences, "radius")).toEqual({ kind: "upload", image: PNG });
    values.set("provider-icon:radius", JSON.stringify({ kind: "site", image: "data:image/svg+xml,<svg onload=x>", site: "x" }));
    expect(readProviderIcon(preferences, "radius")).toBeUndefined();
    writeProviderIcon(preferences, "radius", { kind: "removed" });
    expect(readProviderIcon(preferences, "radius")).toEqual({ kind: "removed" });
  });

  it("hands core every picture by provider id, again only when one changes, and withdraws them", () => {
    const preferences = new PreferencesStore();
    const publish = vi.fn();
    writeProviderIcon(preferences, "radius", { kind: "site", image: PNG, site: "radius.example" });
    writeProviderIcon(preferences, "ant-ling", { kind: "none", checkedAt: 1 });
    const stop = publishProviderIcons(preferences, publish);
    expect(publish).toHaveBeenLastCalledWith({ radius: PNG });
    preferences.setValue("tau.other", "x", "y");
    expect(publish).toHaveBeenCalledTimes(1);
    writeProviderIcon(preferences, "radius", { kind: "removed" });
    expect(publish).toHaveBeenLastCalledWith({});
    stop();
    expect(publish).toHaveBeenLastCalledWith(undefined);
  });
});

describe("fetching site icons without being asked", () => {
  const noMark = () => false;

  it("wants one for a provider set up, with a site, without a mark or a choice; a missing one again after a week", () => {
    expect(wantsSiteIcon(provider("radius"), undefined, noMark, 0)).toBe(true);
    expect(wantsSiteIcon(provider("radius", { configured: false }), undefined, noMark, 0)).toBe(false);
    expect(wantsSiteIcon(provider("radius", { site: undefined }), undefined, noMark, 0)).toBe(false);
    expect(wantsSiteIcon(provider("openai"), undefined, (id) => id === "openai", 0)).toBe(false);
    expect(wantsSiteIcon(provider("radius"), { kind: "removed" }, noMark, 0)).toBe(false);
    expect(wantsSiteIcon(provider("radius"), { kind: "upload", image: PNG }, noMark, 0)).toBe(false);
    expect(wantsSiteIcon(provider("radius"), { kind: "none", checkedAt: 0 }, noMark, RECHECK_MISSING_MS - 1)).toBe(false);
    expect(wantsSiteIcon(provider("radius"), { kind: "none", checkedAt: 0 }, noMark, RECHECK_MISSING_MS)).toBe(true);
  });

  it("fetches one at a time, rasterizes what came, remembers a site without one, and leaves a failure for next time", async () => {
    const stored = new Map<string, ProviderIconChoice>([["done", { kind: "upload", image: PNG }]]);
    const sync: SiteIconSync = {
      providers: async () => [provider("radius"), provider("bare"), provider("offline"), provider("done")],
      read: (id) => stored.get(id),
      write: (id, choice) => { stored.set(id, choice); },
      fetch: vi.fn(async (id: string) => {
        if (id === "offline") throw new Error("offline");
        return id === "radius" ? { site: "radius.example", image: "data:image/svg+xml;base64,PHN2Zy8+" } : { site: "bare.example" };
      }),
      rasterize: vi.fn(async () => PNG),
      hasMark: () => false,
      now: () => 42,
    };
    expect(await syncSiteIcons(sync)).toBe(1);
    expect(sync.fetch).toHaveBeenCalledTimes(3);
    expect(sync.rasterize).toHaveBeenCalledWith("data:image/svg+xml;base64,PHN2Zy8+");
    expect(stored.get("radius")).toEqual({ kind: "site", image: PNG, site: "radius.example" });
    expect(stored.get("bare")).toEqual({ kind: "none", checkedAt: 42 });
    expect(stored.has("offline")).toBe(false);
    expect(await syncSiteIcons(sync)).toBe(0);
    expect(sync.fetch).toHaveBeenCalledTimes(4);
  });
});
