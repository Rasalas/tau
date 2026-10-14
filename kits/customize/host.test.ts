import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { prepareScriptDocument } from "./document.js";
import { createCustomizeHostExtension } from "./host.js";
import { CUSTOMIZE_EXTENSION_ID, type CustomizeState, type ScriptOpen } from "./protocol.js";
import { readState } from "./store.js";

let stateDir: string;
beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), "tau-customize-")); });
afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

async function world() {
  const published: Array<{ html: string; colorScheme?: string }> = [];
  const emitted: unknown[] = [];
  const kit = await activateHostKit(createCustomizeHostExtension(), {
    stateDir,
    browserResources: { publish: () => "/p", publishFrame: (document: unknown) => { published.push(document as never); return "/resources/frame-1"; }, release: () => undefined },
  } as never, (event) => { emitted.push({ name: event.name, payload: event.payload }); });
  const invoke = (command: string, input?: unknown) => kit.invoke(CUSTOMIZE_EXTENSION_ID, command, input);
  return { published, emitted, invoke, close: () => kit.dispose() };
}

const script = { id: "bar", name: "My bar", enabled: true, target: { replace: "page:usage/Summary" }, html: "<b>bar</b>" };

describe("Customize host extension", () => {
  it("keeps the machine's customizations, raises a script's revision on an edit, and answers them again", async () => {
    const w = await world();
    try {
      expect(await w.invoke("get")).toEqual({ version: 1, hidden: [], order: {}, placement: {}, styles: [], scripts: [] });
      const first = await w.invoke("set", { state: { hidden: ["region:usage.juicebars"], scripts: [script] } }) as CustomizeState;
      expect(first.hidden).toEqual(["region:usage.juicebars"]);
      expect(first.scripts[0]!.revision).toBe(1);
      const renamed = await w.invoke("set", { state: { ...first, scripts: [{ ...first.scripts[0]!, name: "Renamed" }] } }) as CustomizeState;
      expect(renamed.scripts[0]!.revision).toBe(1);
      const edited = await w.invoke("set", { state: { ...renamed, scripts: [{ ...renamed.scripts[0]!, html: "<i>new</i>" }] } }) as CustomizeState;
      expect(edited.scripts[0]!.revision).toBe(2);
      expect(w.emitted.at(-1)).toMatchObject({ name: "changed", payload: { scripts: [{ revision: 2 }] } });
      const stored = JSON.parse(await readFile(join(stateDir, CUSTOMIZE_EXTENSION_ID, "customizations.json"), "utf8")) as CustomizeState;
      expect(stored.scripts[0]).toMatchObject({ html: "<i>new</i>", revision: 2 });
    } finally {
      await w.close();
    }
  });

  it("publishes an enabled script as a frame with the bridge, and says when it is gone", async () => {
    const w = await world();
    try {
      await w.invoke("set", { state: { scripts: [script] } });
      const open = await w.invoke("open-script", { id: "bar", colorScheme: "dark", inline: true }) as ScriptOpen;
      expect(open).toEqual({ state: "ready", path: "/resources/frame-1", maxHeight: 480 });
      expect(w.published[0]!.colorScheme).toBe("dark");
      expect(w.published[0]!.html).toContain("window.tau=");
      expect(w.published[0]!.html).toContain("width:max-content");
      expect(w.published[0]!.html).toContain("<b>bar</b>");
      expect(await w.invoke("open-script", { id: "nope" })).toEqual({ state: "missing" });
    } finally {
      await w.close();
    }
  });
});

describe("what the host accepts", () => {
  it("refuses names that are not part names, duplicates and oversized entries", () => {
    expect(() => readState({ hidden: ["region:x"] })).not.toThrow();
    expect(() => readState({ hidden: ["} body { display:none"] })).toThrow(/not a part name/u);
    expect(() => readState({ scripts: [script, script] })).toThrow(/share the id/u);
    expect(() => readState({ styles: [{ id: "s", name: "Big", css: "x".repeat(300 * 1024), enabled: true }] })).toThrow(/larger than/u);
    expect(readState({ placement: { "region:usage.juicebars": "title-bar" } }).placement).toEqual({ "region:usage.juicebars": "title-bar" });
  });

  it("wraps a fragment in a transparent document and keeps the bridge before the user's markup", () => {
    const html = prepareScriptDocument("<div id=out></div><script>tau.data('x', () => {})</script>");
    expect(html.indexOf("window.tau=")).toBeLessThan(html.indexOf("<div id=out>"));
    expect(html).toContain("background:transparent");
    expect(html).not.toContain("width:max-content");
  });
});
