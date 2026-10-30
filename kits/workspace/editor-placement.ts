import type { UiEnvironment, UiEnvironments } from "tau";
import {
  WORKSPACE_HOST_EXTENSION_ID,
  type EditorMachineSetting,
  type EditorOpenOn,
  type EditorPosition,
  type EditorRemoteState,
  type EditorTarget,
  type HostExtensionInvoke,
  type UiPlacedEditor,
  type WorkspaceHostClient,
} from "./protocol.js";
import { chooseRemoteLocation } from "./remote-editors.js";

/** The part of `PlatformEnvironments` placing an editor reads: present only in a client with a window process. */
export interface EditorWindowMachines {
  readonly shownElsewhere?: string;
  getSnapshot(): UiEnvironments | undefined;
  subscribe(listener: () => void): () => void;
  invokeExtension?(machine: string, extensionId: string, command: string, input?: unknown): Promise<unknown>;
}

/**
 * Where "Open in editor" opens the shown project: `host`, by the page's host
 * as before (the project is the window's machine's, or the client has no
 * window); `machine`, by the project's home machine on its own screen, as its
 * Settings chose; `remote`, by an editor of this device over SSH.
 */
export type EditorPlace =
  | { kind: "host" }
  | { kind: "machine"; machine: string; name: string }
  | { kind: "remote"; target: EditorTarget; remote: EditorRemoteState };

/** A host too old to answer `editor-target`: its project opens as it always did. */
function unknownCommand(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "unknown-command" || (error instanceof Error && /no command "editor-target"/u.test(error.message));
}

/**
 * Decides, per project and per open, which machine's editor opens it, and
 * reaches the window's own machine for this device's editors and for what
 * it keeps per other machine. The page may be showing another machine; the
 * window's machine is then reached over the window's own connection.
 */
export class EditorPlacement {
  private settings?: Promise<Record<string, EditorMachineSetting>>;

  constructor(
    private readonly host: WorkspaceHostClient,
    /** The page's own host, which is the window's machine's unless the page shows another. */
    private readonly pageHost: HostExtensionInvoke,
    private readonly machines: EditorWindowMachines,
  ) {}

  /** The window's own machine, once the window's list arrived. */
  localMachine(): UiEnvironment | undefined {
    return this.machines.getSnapshot()?.environments.find((environment) => environment.local);
  }

  private showsLocal(local: UiEnvironment): boolean {
    const shown = this.machines.getSnapshot()?.shown;
    return !this.machines.shownElsewhere && (shown === undefined || shown === local.id);
  }

  /** A command of Workspace Kit on the window's own machine, whichever machine the page shows. */
  async local<T>(command: string, input?: unknown): Promise<T> {
    const local = this.localMachine();
    if (!local) throw new Error("This window's own machine is not listed yet.");
    if (this.showsLocal(local)) return await this.pageHost(command, input) as T;
    if (!this.machines.invokeExtension) throw new Error("This window cannot reach its own machine's editors.");
    return await this.machines.invokeExtension(local.id, WORKSPACE_HOST_EXTENSION_ID, command, input) as T;
  }

  editorMachines(refresh = false): Promise<Record<string, EditorMachineSetting>> {
    if (!this.settings || refresh) {
      const reading = this.local<Record<string, EditorMachineSetting>>("editor-machines");
      this.settings = reading;
      // A failed read is tried again next time.
      reading.catch(() => { if (this.settings === reading) this.settings = undefined; });
    }
    return this.settings;
  }

  async setEditorMachine(machine: string, patch: { ssh?: string | null; openOn?: EditorOpenOn | null }): Promise<Record<string, EditorMachineSetting>> {
    const saved = await this.local<Record<string, EditorMachineSetting>>("set-editor-machine", { machine, ...patch });
    this.settings = Promise.resolve(saved);
    return saved;
  }

  /** What Settings and the editor menu say about one other machine. */
  remoteState(machine: string, name: string, setting: EditorMachineSetting | undefined): EditorRemoteState {
    const environment = this.machines.getSnapshot()?.environments.find((entry) => entry.id === machine);
    const choice = chooseRemoteLocation({
      name: environment?.name ?? name,
      ...(setting?.ssh ? { saved: setting.ssh } : {}),
      ...(environment?.route ? { route: environment.route } : {}),
      ...(environment?.address ? { address: environment.address } : {}),
    });
    const base = { machine, name: environment?.name ?? name };
    return choice.location ? { ...base, location: choice.location, source: choice.source } : { ...base, problem: choice.problem };
  }

  /** Where the project, or a file of it, opens; asks its home machine where it is. */
  async place(workspace?: string, relPath?: string): Promise<EditorPlace> {
    const local = this.localMachine();
    if (!local) return { kind: "host" };
    let target: EditorTarget;
    try {
      target = await this.host.editorTarget(relPath, workspace);
    } catch (error) {
      if (unknownCommand(error)) return { kind: "host" };
      throw error;
    }
    const snapshot = this.machines.getSnapshot();
    // A host that cannot name itself answered for the page's own machine.
    const machine = target.machine?.id ?? (this.showsLocal(local) ? local.id : snapshot?.shown ?? this.machines.shownElsewhere);
    if (!machine || machine === local.id) return { kind: "host" };
    const name = snapshot?.environments.find((entry) => entry.id === machine)?.name ?? target.machine?.name ?? "the other machine";
    const setting = (await this.editorMachines().catch(() => ({} as Record<string, EditorMachineSetting>)))[machine];
    if (setting?.openOn === "machine") return { kind: "machine", machine, name };
    return { kind: "remote", target, remote: this.remoteState(machine, name, setting) };
  }

  /** This device's editors, each with why it cannot open a project at that place when it cannot. */
  async editorsFor(remote: EditorRemoteState): Promise<UiPlacedEditor[]> {
    if (!remote.location) return [];
    return this.local<UiPlacedEditor[]>("remote-editors", { location: remote.location });
  }

  /** Opens what `place` found in one editor of this device. */
  async open(editorId: string, place: Extract<EditorPlace, { kind: "remote" }>, position?: EditorPosition): Promise<void> {
    const { target, remote } = place;
    if (!remote.location) throw new Error(remote.problem ?? `Tau does not know how to reach ${remote.name} over SSH.`);
    await this.local("open-remote-editor", {
      editorId,
      location: remote.location,
      root: target.root,
      ...(target.path && target.isFile ? { path: target.path } : target.path ? { root: target.path } : {}),
      platform: target.platform,
      ...(position?.line ? { line: position.line } : {}),
      ...(position?.column ? { column: position.column } : {}),
    });
  }
}
