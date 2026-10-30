import { describe, expect, it, vi } from "vitest";
import type { UiEnvironment, UiEnvironments } from "tau";
import { EditorPlacement, type EditorWindowMachines } from "./editor-placement.js";
import type { EditorMachineSetting, EditorTarget, WorkspaceHostClient } from "./protocol.js";

const LOCAL = "local-host-id";
const STUDIO = "studio-host-id";

const environment = (id: string, patch: Partial<UiEnvironment> = {}): UiEnvironment =>
  ({ id, name: id === LOCAL ? "Laptop" : "Studio", local: id === LOCAL, status: "connected", threads: [], threadCount: 0, projects: [], ...patch });

function placement(options: {
  target?: EditorTarget | Error;
  environments?: UiEnvironment[] | undefined;
  shown?: string;
  shownElsewhere?: string;
  settings?: Record<string, EditorMachineSetting>;
} = {}) {
  const snapshot: UiEnvironments | undefined = options.environments === undefined && "environments" in options ? undefined : {
    shown: options.shown ?? LOCAL,
    environments: options.environments ?? [environment(LOCAL), environment(STUDIO, { route: { kind: "direct", hosts: ["studio.tail1234.ts.net", "192.168.1.20"] } })],
    secureStorage: true,
  };
  const editorTarget = vi.fn(async () => {
    if (options.target instanceof Error) throw options.target;
    return options.target ?? { root: "/home/me/p", isFile: false, platform: "posix" as const, machine: { id: STUDIO, name: "Studio" } };
  });
  const pageHost = vi.fn(async (command: string, input?: unknown) => {
    if (command === "editor-machines") return options.settings ?? {};
    return { command, input };
  });
  const invokeExtension = vi.fn(async (_machine: string, _extension: string, command: string) => command === "editor-machines" ? options.settings ?? {} : undefined);
  const machines: EditorWindowMachines = {
    ...(options.shownElsewhere ? { shownElsewhere: options.shownElsewhere } : {}),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    invokeExtension,
  };
  const host = { editorTarget } as unknown as WorkspaceHostClient;
  return { placement: new EditorPlacement(host, pageHost, machines), editorTarget, pageHost, invokeExtension };
}

describe("EditorPlacement.place", () => {
  it("leaves a client without a window machine, and a project of the window's machine, to the page's host", async () => {
    expect(await placement({ environments: undefined }).placement.place("ws1")).toEqual({ kind: "host" });
    expect(await placement({ target: { root: "/p", isFile: false, platform: "posix", machine: { id: LOCAL, name: "Laptop" } } }).placement.place("ws1")).toEqual({ kind: "host" });
  });

  it("opens another machine's project here over SSH, at the best name of its addresses", async () => {
    const { placement: place, editorTarget } = placement();
    expect(await place.place("ws1_remote", "src/a.ts")).toEqual({
      kind: "remote",
      target: { root: "/home/me/p", isFile: false, platform: "posix", machine: { id: STUDIO, name: "Studio" } },
      remote: { machine: STUDIO, name: "Studio", location: { kind: "ssh", destination: "studio.tail1234.ts.net" }, source: "address" },
    });
    expect(editorTarget).toHaveBeenCalledWith("src/a.ts", "ws1_remote");
  });

  it("uses the destination saved for that machine, or its own editor when Settings say so", async () => {
    expect((await placement({ settings: { [STUDIO]: { ssh: "me@studio:2222" } } }).placement.place("ws1")))
      .toMatchObject({ kind: "remote", remote: { location: { kind: "ssh", destination: "me@studio:2222" }, source: "saved" } });
    expect(await placement({ settings: { [STUDIO]: { openOn: "machine" } } }).placement.place("ws1")).toEqual({ kind: "machine", machine: STUDIO, name: "Studio" });
  });

  it("says what is missing for a machine reached through Tau Connect", async () => {
    const { placement: place } = placement({ environments: [environment(LOCAL), environment(STUDIO, { route: { kind: "connect" } })] });
    expect(await place.place("ws1")).toMatchObject({ kind: "remote", remote: { problem: expect.stringMatching(/Tau Connect/u) } });
  });

  it("asks for an SSH destination when the machine is known only at a loopback address, as through a manual forward", async () => {
    const { placement: place, pageHost } = placement({ environments: [environment(LOCAL), environment(STUDIO, { route: { kind: "direct", hosts: ["127.0.0.1"] }, address: "https://127.0.0.1:41000/" })] });
    const found = await place.place("ws1", "a.ts");
    expect(found).toMatchObject({ kind: "remote", remote: { machine: STUDIO, problem: expect.stringMatching(/only at a local address/u) } });
    if (found.kind !== "remote") throw new Error("expected a remote place");
    await expect(place.open("code", found)).rejects.toThrow(/only at a local address/u);
    expect(pageHost).not.toHaveBeenCalledWith("open-remote-editor", expect.anything());
  });

  it("takes a page showing another machine, whose host cannot name itself, for that machine, and reaches its own over the window", async () => {
    const { placement: place, pageHost, invokeExtension } = placement({
      shown: STUDIO,
      shownElsewhere: STUDIO,
      target: { root: "/srv/p", isFile: false, platform: "posix" },
      settings: { [STUDIO]: { ssh: "studio" } },
    });
    expect(await place.place("ws1")).toMatchObject({ kind: "remote", remote: { machine: STUDIO, location: { kind: "ssh", destination: "studio" } } });
    expect(invokeExtension).toHaveBeenCalledWith(LOCAL, "tau.workspace", "editor-machines", undefined);
    expect(pageHost).not.toHaveBeenCalled();
  });

  it("opens a project of a host too old to answer the way it always did", async () => {
    const old = Object.assign(new Error('Host extension Workspace has no command "editor-target".'), { code: "unknown-command" });
    expect(await placement({ target: old }).placement.place("ws1")).toEqual({ kind: "host" });
    await expect(placement({ target: new Error("offline") }).placement.place("ws1")).rejects.toThrow("offline");
  });
});

describe("EditorPlacement.open", () => {
  it("asks the window machine's host to open the file at its line on the other machine", async () => {
    const { placement: place, pageHost } = placement({ target: { root: "/home/me/p", path: "/home/me/p/a.ts", isFile: true, platform: "posix", machine: { id: STUDIO, name: "Studio" } } });
    const found = await place.place("ws1", "a.ts");
    if (found.kind !== "remote") throw new Error("expected a remote place");
    await place.open("code", found, { line: 7, column: 2 });
    expect(pageHost).toHaveBeenLastCalledWith("open-remote-editor", {
      editorId: "code",
      location: { kind: "ssh", destination: "studio.tail1234.ts.net" },
      root: "/home/me/p",
      path: "/home/me/p/a.ts",
      platform: "posix",
      line: 7,
      column: 2,
    });
  });

  it("opens a folder of the project as the folder, and refuses without a destination", async () => {
    const { placement: place, pageHost } = placement({ target: { root: "/home/me/p", path: "/home/me/p/src", isFile: false, platform: "posix", machine: { id: STUDIO, name: "Studio" } } });
    const found = await place.place("ws1", "src");
    if (found.kind !== "remote") throw new Error("expected a remote place");
    await place.open("zed", found);
    expect(pageHost).toHaveBeenLastCalledWith("open-remote-editor", expect.objectContaining({ root: "/home/me/p/src" }));
    await expect(place.open("zed", { ...found, remote: { machine: STUDIO, name: "Studio", problem: "No SSH." } })).rejects.toThrow("No SSH.");
  });
});
