import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { findExecutable, type UiTerminal } from "tau/host-extension";

const execFileAsync = promisify(execFile);

/** Terminals we know how to launch. */
export const KNOWN_TERMINALS: ReadonlyArray<UiTerminal> = [
  { id: "ghostty", name: "Ghostty" },
  { id: "iterm", name: "iTerm" },
  { id: "warp", name: "Warp" },
  { id: "kitty", name: "Kitty" },
  { id: "alacritty", name: "Alacritty" },
  { id: "terminal", name: "Terminal" },
];

export async function listTerminals(): Promise<UiTerminal[]> {
  if (process.platform === "darwin") {
    const apps: Record<string, string> = {
      ghostty: "/Applications/Ghostty.app",
      iterm: "/Applications/iTerm.app",
      warp: "/Applications/Warp.app",
      kitty: "/Applications/kitty.app",
      alacritty: "/Applications/Alacritty.app",
      terminal: "/System/Applications/Utilities/Terminal.app",
    };
    return KNOWN_TERMINALS.filter((term) => findExecutable(term.id) !== undefined || (apps[term.id] && existsSync(apps[term.id])));
  }
  return KNOWN_TERMINALS.filter((term) => findExecutable(term.id) !== undefined);
}

export async function openTerminal(cwd: string, terminalId?: string): Promise<void> {
  const available = await listTerminals();
  const chosen = terminalId ? KNOWN_TERMINALS.find((t) => t.id === terminalId) : available[0];
  const target = chosen?.id ?? (process.platform === "darwin" ? "terminal" : "xterm");

  if (process.platform === "darwin") {
    const appNames: Record<string, string> = {
      ghostty: "Ghostty",
      iterm: "iTerm",
      warp: "Warp",
      kitty: "kitty",
      alacritty: "Alacritty",
      terminal: "Terminal",
    };
    const appName = appNames[target] ?? "Terminal";
    await execFileAsync("open", ["-a", appName, cwd], { cwd });
  } else if (process.platform === "win32") {
    await execFileAsync("wt.exe", ["-d", cwd], { cwd }).catch(() =>
      execFileAsync("cmd.exe", ["/c", "start"], { cwd })
    );
  } else {
    await execFileAsync(target, [], { cwd });
  }
}
