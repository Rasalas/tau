import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageIndexControl } from "./index-control.js";

const roots: string[] = [];
const controls: MessageIndexControl[] = [];
afterEach(async () => { await Promise.all(controls.splice(0).map(control => control.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const message = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-search-control-")); roots.push(root);
  const path = join(root, "session.jsonl"); await writeFile(path, message("old beacon"));
  const sessions = vi.fn(async () => [{ sessionId: "one", path }]);
  const publish = vi.fn();
  const options = { stateDir: root, sessions, publish, ask: async () => { throw new Error("runtime not installed"); } };
  const control = new MessageIndexControl(options); controls.push(control);
  await control.settled();
  return { root, path, sessions, publish, control, options };
}

describe("message index control", () => {
  it("keeps the completed generation searchable until an entire rebuild is published", async () => {
    const { control, path, sessions } = await fixture();
    expect(control.snapshot()).toMatchObject({ enabled: true, state: "ready", threads: 1 });
    expect(control.snapshot().bytes).toBeGreaterThan(0);
    const old = control.active!;
    const gate = deferred(); sessions.mockImplementationOnce(async () => { await gate.promise; return [{ sessionId: "one", path }]; });
    await writeFile(path, message("new beacon"));
    await control.rebuild();
    expect(control.snapshot().state).toBe("indexing");
    expect(control.active).toBe(old);
    expect(await old.index.searchCommittedPi({ source: "pi", id: "one", path }, ["old"])).toBeDefined();
    expect(await old.index.searchCommittedPi({ source: "pi", id: "one", path }, ["new"])).toBeUndefined();
    gate.resolve(); await control.settled();
    expect(control.active).not.toBe(old);
    expect(await control.active!.index.searchCommittedPi({ source: "pi", id: "one", path }, ["new"])).toBeDefined();
  });

  it("aborts a rebuild before deleting all generations and persists off across restart", async () => {
    const { control, path, root, sessions, options, publish } = await fixture();
    const gate = deferred(); sessions.mockImplementationOnce(async () => { await gate.promise; return [{ sessionId: "one", path }]; });
    await control.rebuild();
    const off = control.configure(false);
    await vi.waitFor(() => expect(control.snapshot().enabled).toBe(false));
    expect(control.active).toBeUndefined();
    const afterOff = publish.mock.calls.length;
    gate.resolve(); await off;
    expect(publish.mock.calls.slice(afterOff).every(([status]) => status.state === "disabled")).toBe(true);
    expect(await readdir(join(root, "message-index")).catch(() => [])).toEqual([]);
    expect(JSON.parse(await readFile(join(root, "message-index.json"), "utf8"))).toEqual({ enabled: false });
    await control.dispose();
    const restarted = new MessageIndexControl(options); controls.push(restarted);
    await restarted.settled();
    expect(restarted.snapshot()).toMatchObject({ enabled: false, state: "disabled", bytes: 0, threads: 0 });
  });

  it("serializes rapid off/on and retries a failed build without publishing partial files", async () => {
    const { control, path } = await fixture();
    await Promise.all([control.configure(false), control.configure(true)]);
    await control.settled();
    expect(control.snapshot().state).toBe("ready");
    const old = control.active;
    await rm(path);
    await control.rebuild(); await control.settled();
    expect(control.snapshot()).toMatchObject({ state: "error", enabled: true });
    expect(control.active).toBe(old);
    await writeFile(path, message("repaired beacon"));
    await control.rebuild(); await control.settled();
    expect(control.snapshot().state).toBe("ready");
    expect(control.active).not.toBe(old);
  });
});

it("automatically refreshes again after a transient failed generation", async () => {
  const { control, path } = await fixture();
  await rm(path); await control.rebuild(); await control.settled();
  expect(control.snapshot().state).toBe("error");
  await writeFile(path, message("recovered beacon"));
  control.refresh(true); await control.settled();
  expect(control.snapshot().state).toBe("ready");
});
it("does not advertise restored unavailable runtime sources as complete", async () => {
  const { control, root, options } = await fixture();
  await control.active!.index.putRuntime("tau.codex", "saved-codex", 1, [{ role: "user", text: "old persisted message" }]);
  await control.dispose();
  const restarted = new MessageIndexControl({ ...options, stateDir: root }); controls.push(restarted);
  await restarted.settled();
  expect(restarted.snapshot().state).not.toBe("ready");
});
