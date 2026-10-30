import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EditorMachineSettings } from "./editor-machines.js";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

async function settings() {
  const folder = await mkdtemp(join(tmpdir(), "tau-editor-machines-"));
  folders.push(folder);
  const file = join(folder, "state", "editor-machines.json");
  return { file, store: new EditorMachineSettings(file) };
}

it("keeps a destination and a choice per machine, as written in Settings, and clears them", async () => {
  const { file, store } = await settings();
  expect(await store.read()).toEqual({});
  await store.set("machine-a", { ssh: " ssh://me@studio:2222 " });
  await store.set("machine-a", { openOn: "machine" });
  expect(await store.set("machine-b", { ssh: "dev-box" })).toEqual({ "machine-a": { ssh: "me@studio:2222", openOn: "machine" }, "machine-b": { ssh: "dev-box" } });
  expect(await new EditorMachineSettings(file).read()).toEqual({ "machine-a": { ssh: "me@studio:2222", openOn: "machine" }, "machine-b": { ssh: "dev-box" } });
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  await store.set("machine-a", { ssh: null, openOn: null });
  expect(await store.set("machine-b", { ssh: "" })).toEqual({});
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, machines: {} });
});

it("refuses a destination SSH would read as an option, and writes nothing", async () => {
  const { store } = await settings();
  await expect(store.set("machine-a", { ssh: "-oProxyCommand=evil" })).rejects.toThrow(/not a host name/u);
  await expect(store.set("../x", { ssh: "box" })).rejects.toThrow(/machine/u);
  expect(await store.read()).toEqual({});
});

it("serializes writes, so two changes in a row both stay", async () => {
  const { store } = await settings();
  await Promise.all([store.set("a", { ssh: "a-box" }), store.set("b", { ssh: "b-box" })]);
  expect(await store.read()).toEqual({ a: { ssh: "a-box" }, b: { ssh: "b-box" } });
});
