import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createPreviewHostExtension, type PreviewSurface, type PreviewSurfaceOptions } from "./host.js";
import { EMPTY_PREVIEW_STATE, PREVIEW_HOST_EXTENSION_ID } from "./protocol.js";
import { writeFirefoxStore } from "./cookie-fixtures.js";
import type { CookieToWrite } from "./cookie-read.js";

const folders: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function latch() { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; }
async function setup(options: { helper?: "missing" | "desktop" | "startup" | "write" | "flush" | "close" | "write-flush"; activeClose?: boolean; gate?: ReturnType<typeof latch> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-headless-cookie-test-")); folders.push(root);
  vi.stubEnv("TAU_IMPORT_ROOTS", root);
  const home = join(root, "browsers");
  const firefox = process.platform === "darwin" ? join(home, "Library", "Application Support", "Firefox")
    : process.platform === "win32" ? join(home, "AppData", "Roaming", "Mozilla", "Firefox") : join(home, ".mozilla", "firefox");
  await mkdir(firefox, { recursive: true });
  await writeFile(join(firefox, "profiles.ini"), "[Profile0]\nName=Fixture\nIsRelative=1\nPath=Profiles/fixture.default\n");
  writeFirefoxStore(join(firefox, "Profiles", "fixture.default", "cookies.sqlite"), [
    { host: "selected.test", name: "fixture", value: "synthetic" },
    { host: "other.test", name: "other", value: "excluded" },
  ]);
  const events: string[] = [];
  const written: Array<{ partition: string; cookie: CookieToWrite }> = [];
  const created: Array<{ options: PreviewSurfaceOptions; surface: PreviewSurface }> = [];
  const client = vi.fn(async () => { throw new Error("Must not write through the client"); });
  let forcedSurfaces = 0;
  const registry = await activateHostKit(createPreviewHostExtension(async (surfaceOptions) => {
    const helper = surfaceOptions.headless === true && forcedSurfaces++ === 0 && !options.activeClose;
    events.push(`open:${surfaceOptions.partition}:${helper ? "helper" : "page"}`);
    if (helper && options.helper === "startup") throw new Error("helper startup failed");
    if (helper && options.helper === "missing") return undefined;
    let url = "";
    const surface: PreviewSurface = {
      zoomFactor: () => 1, place: () => undefined, navigate: () => undefined, setZoom: () => undefined,
      setAppearance: async () => undefined, viewport: () => ({ width: 800, height: 600 }),
      state: () => ({ ...EMPTY_PREVIEW_STATE, available: true, surface: helper && options.helper === "desktop" ? undefined : "headless", url }),
      load: async (next) => { url = next; events.push(`load:${surfaceOptions.partition}`); },
      evaluate: async () => undefined, capture: async () => ({ base64: "", width: 1, height: 1 }),
      record: async () => ({ chunks: [], mimeType: "video/mp4" }), pressKey: () => undefined,
      cookies: {
        set: async (cookie) => {
          events.push(`write:${surfaceOptions.partition}`); await options.gate?.wait;
          if ((options.helper === "write" || options.helper === "write-flush")) throw new Error("write failed");
          written.push({ partition: surfaceOptions.partition, cookie });
        },
        flushStore: async () => { events.push(`flush:${helper ? "helper" : "page"}`); if ((helper && (options.helper === "flush" || options.helper === "write-flush")) || (!helper && options.activeClose)) throw new Error("flush failed"); },
      },
      destroy: async () => { events.push(`close:${surfaceOptions.partition}:${helper ? "helper" : "page"}`); if (helper && options.helper === "close") throw new Error("close failed"); },
    };
    created.push({ options: surfaceOptions, surface }); return surface;
  }, () => ({ inProcess: false, call: client })), {
    stateDir: join(root, "state"), findCommand: () => undefined,
    registerTurnObserver: () => () => undefined, registerRuntimeExtension: () => () => undefined,
  });
  const call = (command: string, input?: unknown) => registry.invoke(PREVIEW_HOST_EXTENSION_ID, command, input);
  const request = { source: "firefox", profile: "Profiles/fixture.default", sites: ["selected.test"], into: "default", partition: "persist:workbench" };
  return { registry, call, request, events, written, created, client };
}

describe("headless cookie import through the user dialog commands", () => {
  it("lists only fixture sources/sites and imports only selected sites into the active owned profile", async () => {
    const test = await setup();
    try {
      await expect(test.call("import-sources")).resolves.toMatchObject([{ id: "firefox" }]);
      await expect(test.call("import-sites", test.request)).resolves.toEqual([{ site: "other.test", cookies: 1 }, { site: "selected.test", cookies: 1 }]);
      await test.call("open", { url: "https://fixture.invalid/" });
      const result = await test.call("import-cookies", test.request);
      expect(result).toEqual({ imported: 1, skipped: 0, skippedSites: [], profile: "default", reloaded: true });
      expect(JSON.stringify(result)).not.toContain("synthetic");
      expect(test.written.map(({ partition, cookie }) => [partition, cookie.name])).toEqual([["persist:tau-preview", "fixture"]]);
      expect(test.events).toEqual(["open:persist:tau-preview:page", "load:persist:tau-preview", "flush:page", "close:persist:tau-preview:page", "open:persist:tau-preview:helper", "write:persist:tau-preview", "flush:helper", "close:persist:tau-preview:helper", "open:persist:tau-preview:page", "load:persist:tau-preview"]);
      expect(test.created.slice(1).every(({ options }) => options.headless)).toBe(true);
      expect(test.client).not.toHaveBeenCalled();
    } finally { await test.registry.dispose(); }
  });
  it("leaves the active profile untouched when importing into another profile", async () => {
    const test = await setup();
    try {
      await test.call("use-profile", { name: "work" }); await test.call("use-profile", { name: "default" });
      await test.call("open", { url: "https://fixture.invalid/" }); test.events.length = 0;
      expect(await test.call("import-cookies", { ...test.request, into: "work" })).toMatchObject({ profile: "work", reloaded: false });
      expect(test.events).toEqual(["open:persist:tau-preview-work:helper", "write:persist:tau-preview-work", "flush:helper", "close:persist:tau-preview-work:helper"]);
      expect((await test.call("profiles") as { active: string }).active).toBe("default");
    } finally { await test.registry.dispose(); }
  });
  it("revalidates the selected profile after an earlier deletion", async () => {
    const test = await setup();
    try {
      await test.call("use-profile", { name: "work" }); await test.call("use-profile", { name: "default" });
      await test.call("delete-profile", { id: "work" });
      await expect(test.call("import-cookies", { ...test.request, into: "work" })).rejects.toThrow("[unknown-profile]");
      expect(test.written).toEqual([]);
    } finally { await test.registry.dispose(); }
  });
  it.each(["missing", "desktop", "startup", "flush", "close", "write-flush"] as const)("cleans up and restores the pinned page after %s failure", async (helper) => {
    const test = await setup({ helper });
    try {
      await test.call("open", { url: "https://fixture.invalid/" });
      await expect(test.call("import-cookies", test.request)).rejects.toThrow();
      expect((await test.call("state") as { url: string }).url).toBe("https://fixture.invalid/");
      if (!["missing", "startup"].includes(helper)) expect(test.events).toContain("close:persist:tau-preview:helper");
      expect(test.client).not.toHaveBeenCalled();
    } finally { await test.registry.dispose(); }
  });
  it("refuses the import if the active profile did not finish saving before handoff", async () => {
    const test = await setup({ activeClose: true });
    try {
      await test.call("open", { url: "https://fixture.invalid/" });
      await expect(test.call("import-cookies", test.request)).rejects.toThrow("flush failed");
      expect(test.written).toEqual([]);
      expect(test.events.some((event) => event.endsWith(":helper"))).toBe(false);
      expect((await test.call("state") as { url: string }).url).toBe("https://fixture.invalid/");
    } finally { await test.registry.dispose(); }
  });
  it("counts refused writes without leaking their values", async () => {
    const test = await setup({ helper: "write" });
    try { expect(await test.call("import-cookies", test.request)).toEqual({ imported: 0, skipped: 1, skippedSites: ["selected.test"], profile: "default", reloaded: false }); }
    finally { await test.registry.dispose(); }
  });
  it("keeps a user-approved import pending beyond the registry's ordinary client timeout", async () => {
    const gate = latch(); const test = await setup({ gate });
    await test.call("open", { url: "https://fixture.invalid/" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const importing = test.call("import-cookies", test.request);
    void importing.catch(() => undefined);
    try {
      while (!test.events.some((event) => event.startsWith("write:"))) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(31_000);
      gate.release();
      await expect(importing).resolves.toMatchObject({ imported: 1, profile: "default", reloaded: true });
    } finally { gate.release(); vi.useRealTimers(); await test.registry.dispose(); }
  });
  it("holds profile mutation and shutdown behind the import, closing the helper first", async () => {
    const gate = latch(); const test = await setup({ gate });
    await test.call("open", { url: "https://fixture.invalid/" });
    const importing = test.call("import-cookies", test.request);
    while (!test.events.some((event) => event.startsWith("write:"))) await new Promise((resolve) => setImmediate(resolve));
    let changed = false; const changing = test.call("use-profile", { name: "work" }).then(() => { changed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    let stopped = false; const stopping = test.registry.dispose().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(changed).toBe(false); expect(stopped).toBe(false);
    gate.release(); await importing; await changing; await stopping;
    expect(test.events.indexOf("close:persist:tau-preview:helper")).toBeLessThan(test.events.lastIndexOf("load:persist:tau-preview"));
    expect(test.client).not.toHaveBeenCalled();
  });
});
