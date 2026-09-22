import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import type { HostExtensionContext } from "tau/host-extension";
import { registerAppOpen } from "./app-open.js";
import { OpenRequests } from "./open-requests.js";
import { APP_OPEN_COMMAND, OPEN_REQUEST_EVENT, TAKE_OPEN_REQUEST_COMMAND } from "./storage-protocol.js";

const made: string[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function host(clients: number, focus: () => Promise<unknown>) {
  const commands = new Map<string, (input: unknown) => unknown>();
  const events: Array<[string, unknown]> = [];
  let now = 1_000;
  const context = {
    services: {
      workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
      clients: { count: () => clients, observe: () => () => undefined },
      callClient: vi.fn(focus),
      log: () => undefined,
    },
    registerCommand: (name: string, handler: (input: unknown) => unknown) => { commands.set(name, handler); },
    emit: (name: string, payload: unknown) => { events.push([name, payload]); },
  } as unknown as HostExtensionContext;
  registerAppOpen(context, () => now);
  const call = (name: string, input?: unknown) => Promise.resolve(commands.get(name)!(input));
  return { call, events, context, advance: (ms: number) => { now += ms; } };
}

async function folder(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "tau-app-open-")));
  made.push(path);
  return path;
}

describe("tau app on the host", () => {
  it("hands the folder to the attached window and brings it forward", async () => {
    const path = await folder();
    const kit = host(1, async () => true);
    expect(await kit.call(APP_OPEN_COMMAND, { path })).toEqual({ workspaceId: `ws1_${path}`, displayPath: path, delivered: true, focused: true });
    expect(kit.events).toEqual([[OPEN_REQUEST_EVENT, { workspaceId: `ws1_${path}`, displayPath: path, requestedAt: 1_000 }]]);
    expect(kit.context.services.callClient).toHaveBeenCalledWith("focus");
    expect(await kit.call(TAKE_OPEN_REQUEST_COMMAND)).toBeNull();
  });

  it("keeps the request for the next window while none is attached, for a while", async () => {
    const path = await folder();
    const kit = host(0, async () => { throw new Error("no window"); });
    expect(await kit.call(APP_OPEN_COMMAND, { path })).toMatchObject({ delivered: false, focused: false });
    expect(kit.events).toEqual([]);
    expect(await kit.call(TAKE_OPEN_REQUEST_COMMAND)).toMatchObject({ workspaceId: `ws1_${path}` });
    expect(await kit.call(TAKE_OPEN_REQUEST_COMMAND)).toBeNull();
    await kit.call(APP_OPEN_COMMAND, { path });
    kit.advance(3 * 60_000);
    expect(await kit.call(TAKE_OPEN_REQUEST_COMMAND)).toBeNull();
  });

  it("says when a browser client got it but no window could be raised", async () => {
    const path = await folder();
    const kit = host(1, async () => { throw new Error("This window has no half of tau.workspace."); });
    expect(await kit.call(APP_OPEN_COMMAND, { path })).toMatchObject({ delivered: true, focused: false });
  });

  it("refuses anything but an absolute folder", async () => {
    const path = await folder();
    await writeFile(join(path, "file.txt"), "");
    const kit = host(1, async () => true);
    await expect(kit.call(APP_OPEN_COMMAND, { path: "relative" })).rejects.toThrow(/absolute/u);
    await expect(kit.call(APP_OPEN_COMMAND, { path: join(path, "file.txt") })).rejects.toThrow(/not a folder/u);
  });
});

describe("tau app in the window", () => {
  it("opens the project and a new thread once the workbench bound its actions", async () => {
    const order: string[] = [];
    const actions = {
      openWorkspace: vi.fn(async (id: string) => { order.push(`open ${id}`); return true; }),
      newSession: (options?: { workspace?: string }) => order.push(`new thread in ${options?.workspace}`),
      focusComposer: () => order.push("focus"),
      notify: () => undefined,
    } as unknown as WorkbenchActions;
    const requests = new OpenRequests();
    requests.receive({ workspaceId: "ws1_a", displayPath: "/a", requestedAt: 1 });
    requests.receive("not a request");
    expect(order).toEqual([]);
    requests.bind(actions);
    await vi.waitFor(() => expect(order).toEqual(["open ws1_a", "new thread in ws1_a", "focus"]));
  });
});
