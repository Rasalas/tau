import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { commandInvocation, type UiEditor } from "tau/host-extension";

/** How a command-line launcher takes a line: `--goto file:line`, `--line n file`, or not at all. */
export type EditorLaunchStyle = "direct-path" | "goto" | "line-column";

interface EditorDefinition {
  id: string;
  name: string;
  commands: readonly string[];
  launchStyle: EditorLaunchStyle;
  baseArgs?: readonly string[];
  /** macOS bundles, found when the CLI is not on PATH; `cli` is a launcher inside that takes lines. */
  apps?: ReadonlyArray<{ bundle: string; cli?: string }>;
}

const VS_CODE_CLI = "Contents/Resources/app/bin";
const jetbrains = (id: string, name: string, bundles: readonly string[]): EditorDefinition => ({
  id, name, commands: [id], launchStyle: "line-column", apps: bundles.map((bundle) => ({ bundle })),
});

/**
 * Every editor "Open in" offers, in menu order; ids are what the picker
 * stores, so the ones Tau shipped before (`code`, `subl`) keep theirs.
 */
export const EDITORS: readonly EditorDefinition[] = [
  { id: "cursor", name: "Cursor", commands: ["cursor"], launchStyle: "goto", baseArgs: ["--classic"], apps: [{ bundle: "Cursor.app", cli: `${VS_CODE_CLI}/cursor` }] },
  { id: "code", name: "VS Code", commands: ["code"], launchStyle: "goto", apps: [{ bundle: "Visual Studio Code.app", cli: `${VS_CODE_CLI}/code` }] },
  { id: "code-insiders", name: "VS Code Insiders", commands: ["code-insiders"], launchStyle: "goto", apps: [{ bundle: "Visual Studio Code - Insiders.app", cli: `${VS_CODE_CLI}/code-insiders` }] },
  { id: "codium", name: "VSCodium", commands: ["codium"], launchStyle: "goto", apps: [{ bundle: "VSCodium.app", cli: `${VS_CODE_CLI}/codium` }] },
  { id: "windsurf", name: "Windsurf", commands: ["windsurf"], launchStyle: "goto", apps: [{ bundle: "Windsurf.app", cli: `${VS_CODE_CLI}/windsurf` }] },
  { id: "trae", name: "Trae", commands: ["trae"], launchStyle: "goto", apps: [{ bundle: "Trae.app" }] },
  { id: "kiro", name: "Kiro", commands: ["kiro"], launchStyle: "goto", apps: [{ bundle: "Kiro.app" }] },
  { id: "antigravity", name: "Antigravity", commands: ["agy", "antigravity"], launchStyle: "goto", apps: [{ bundle: "Antigravity.app" }] },
  { id: "zed", name: "Zed", commands: ["zed", "zeditor"], launchStyle: "direct-path", apps: [{ bundle: "Zed.app", cli: "Contents/MacOS/cli" }] },
  { id: "subl", name: "Sublime Text", commands: ["subl"], launchStyle: "direct-path", apps: [{ bundle: "Sublime Text.app", cli: "Contents/SharedSupport/bin/subl" }] },
  jetbrains("idea", "IntelliJ IDEA", ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"]),
  jetbrains("aqua", "Aqua", ["Aqua.app"]),
  jetbrains("clion", "CLion", ["CLion.app"]),
  jetbrains("datagrip", "DataGrip", ["DataGrip.app"]),
  jetbrains("dataspell", "DataSpell", ["DataSpell.app"]),
  jetbrains("goland", "GoLand", ["GoLand.app"]),
  jetbrains("phpstorm", "PhpStorm", ["PhpStorm.app"]),
  jetbrains("pycharm", "PyCharm", ["PyCharm.app", "PyCharm Professional Edition.app", "PyCharm CE.app", "PyCharm Community Edition.app"]),
  jetbrains("rider", "Rider", ["Rider.app"]),
  jetbrains("rubymine", "RubyMine", ["RubyMine.app"]),
  jetbrains("rustrover", "RustRover", ["RustRover.app"]),
  jetbrains("webstorm", "WebStorm", ["WebStorm.app"]),
];

/** The one entry that is not an editor: it shows the file in the system's file manager. */
export const FILE_MANAGER_ID = "file-manager";

export interface EditorPosition {
  line?: number;
  column?: number;
}

/** How one installed editor is started: a launcher that takes arguments, or a macOS bundle. */
export type EditorLaunch =
  | { kind: "command"; command: string; style: EditorLaunchStyle; baseArgs: readonly string[] }
  | { kind: "app"; bundle: string }
  | { kind: "file-manager" };

export interface InstalledEditor extends UiEditor {
  launch: EditorLaunch;
}

export interface EditorProbe {
  platform: NodeJS.Platform;
  home: string;
  findCommand(name: string): string | undefined;
  exists(path: string): boolean;
}

export function defaultEditorProbe(findCommand: (name: string) => string | undefined): EditorProbe {
  return { platform: process.platform, home: homedir(), findCommand, exists: existsSync };
}

/** Where JetBrains Toolbox writes its launcher scripts, which are rarely on the login PATH. */
function toolboxScripts(probe: EditorProbe): string | undefined {
  if (probe.platform === "darwin") return join(probe.home, "Library/Application Support/JetBrains/Toolbox/scripts");
  if (probe.platform === "linux") return join(probe.home, ".local/share/JetBrains/Toolbox/scripts");
  if (probe.platform === "win32") return win32.join(probe.home, "AppData", "Local", "JetBrains", "Toolbox", "scripts");
  return undefined;
}

export function fileManagerName(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "Finder" : platform === "win32" ? "Explorer" : "Files";
}

function findLaunch(definition: EditorDefinition, probe: EditorProbe): EditorLaunch | undefined {
  const baseArgs = definition.baseArgs ?? [];
  for (const name of definition.commands) {
    const command = probe.findCommand(name);
    if (command) return { kind: "command", command, style: definition.launchStyle, baseArgs };
  }
  const scripts = toolboxScripts(probe);
  if (scripts && definition.launchStyle === "line-column") {
    const script = probe.platform === "win32" ? win32.join(scripts, `${definition.id}.cmd`) : join(scripts, definition.id);
    if (probe.exists(script)) return { kind: "command", command: script, style: "line-column", baseArgs };
  }
  if (probe.platform !== "darwin") return undefined;
  for (const app of definition.apps ?? []) {
    for (const folder of ["/Applications", join(probe.home, "Applications")]) {
      const bundle = join(folder, app.bundle);
      if (!probe.exists(bundle)) continue;
      const cli = app.cli ? join(bundle, app.cli) : undefined;
      if (cli && probe.exists(cli)) return { kind: "command", command: cli, style: definition.launchStyle, baseArgs };
      return { kind: "app", bundle };
    }
  }
  return undefined;
}

/** The editors on this machine, in menu order, with the file manager last. */
export function findInstalledEditors(probe: EditorProbe): InstalledEditor[] {
  const installed: InstalledEditor[] = [];
  for (const definition of EDITORS) {
    const launch = findLaunch(definition, probe);
    if (launch) installed.push({ id: definition.id, name: definition.name, launch });
  }
  const fileManager = probe.platform === "darwin" || probe.platform === "win32" || Boolean(probe.findCommand("xdg-open"));
  if (fileManager) installed.push({ id: FILE_MANAGER_ID, name: fileManagerName(probe.platform), launch: { kind: "file-manager" } });
  return installed;
}

/** The command and arguments that open `target` (a folder, or a file at a position) in one editor. */
export function editorCommand(
  editor: InstalledEditor,
  target: string,
  options: { position?: EditorPosition; isFile: boolean; platform: NodeJS.Platform },
): { command: string; args: string[] } {
  const { launch } = editor;
  const line = options.isFile && options.position?.line && options.position.line > 0 ? options.position.line : undefined;
  const column = line && options.position?.column && options.position.column > 0 ? options.position.column : undefined;
  if (launch.kind === "file-manager") {
    if (options.platform === "darwin") return { command: "open", args: options.isFile ? ["-R", target] : [target] };
    if (options.platform === "win32") return { command: "explorer.exe", args: options.isFile ? [`/select,${target}`] : [target] };
    return { command: "xdg-open", args: [options.isFile ? dirname(target) : target] };
  }
  if (launch.kind === "app") return { command: "open", args: ["-a", launch.bundle, target] };
  const base = [...launch.baseArgs];
  if (!line || launch.style === "direct-path") {
    // Zed and Sublime read `file:line` themselves.
    return { command: launch.command, args: [...base, line ? `${target}:${line}${column ? `:${column}` : ""}` : target] };
  }
  if (launch.style === "goto") return { command: launch.command, args: [...base, "--goto", `${target}:${line}${column ? `:${column}` : ""}`] };
  return { command: launch.command, args: [...base, "--line", String(line), ...(column ? ["--column", String(column)] : []), target] };
}

/**
 * Starts the editor and returns once it is running; a GUI launcher is never
 * waited for. On Windows `code.cmd` and Toolbox's scripts run through cmd.exe,
 * whose console is hidden; an editor's own .exe is not, or its window would be.
 */
export function launchEditor(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const invocation = commandInvocation(command, args);
    const viaShell = invocation.windowsVerbatimArguments === true;
    const child = spawn(invocation.command, invocation.args, { cwd, detached: true, stdio: "ignore", windowsHide: viaShell, windowsVerbatimArguments: viaShell });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}
