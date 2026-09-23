import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { commandInvocation } from "./platform-process.js";

export interface ExternalEditorOptions {
  /** Explicit editor command override, e.g. from config or settings. */
  editorCommand?: string;
  /** Initial text to populate in the editor. */
  initialText?: string;
  /** Environment variables to use (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Platform override for testing. */
  platform?: NodeJS.Platform;
}

export interface ExternalEditorResult {
  text: string;
  modified: boolean;
}

const CLI_EDITORS = new Set([
  "nvim", "vim", "vi", "nano", "pico", "emacs", "helix", "hx", "micro", "kak", "ed",
]);

/**
 * Resolves the editor command line:
 * 1. options.editorCommand
 * 2. env.VISUAL
 * 3. env.EDITOR
 * 4. Fallback: 'notepad' on Windows, 'nano' elsewhere
 */
export function resolveEditorCommand(options: ExternalEditorOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (options.editorCommand?.trim()) {
    return options.editorCommand.trim();
  }
  if (env.VISUAL?.trim()) {
    return env.VISUAL.trim();
  }
  if (env.EDITOR?.trim()) {
    return env.EDITOR.trim();
  }
  return platform === "win32" ? "notepad" : "nano";
}

/** Determines whether the given editor command is a terminal-based editor. */
export function isTerminalEditor(command: string, platform: NodeJS.Platform = process.platform): boolean {
  const binary = editorCommandArgv(command, platform)?.[0] ?? command.trim().split(/\s+/)[0];
  const baseName = binary.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  return CLI_EDITORS.has(baseName);
}

/**
 * Characters that only a shell can interpret. When present, the command line is
 * passed to the shell verbatim as a last resort; otherwise it is parsed into
 * argv and spawned without a shell.
 */
const SHELL_METACHARACTERS = /[>|;`&$(){}[\]*?~\n]/;
/** cmd.exe's; parentheses and brackets are common in Windows paths and harmless there. */
const CMD_METACHARACTERS = /[<>|&^%\n]/;

/**
 * Splits a command line into argv, respecting single quotes, double quotes, and
 * backslash escapes. Returns null if quotes are unterminated. On Windows a
 * backslash is a path separator and only double quotes quote.
 */
export function parseCommandArgv(command: string, platform: NodeJS.Platform = process.platform): string[] | null {
  if (platform === "win32") return parseWindowsArgv(command);
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote || escaped) return null;
  if (started) argv.push(current);
  return argv;
}

function parseWindowsArgv(command: string): string[] | null {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (const char of command.trim()) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) argv.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) return null;
  if (started) argv.push(current);
  return argv;
}

/** Returns argv for the command line, or null if it needs a shell to interpret. */
export function editorCommandArgv(command: string, platform: NodeJS.Platform = process.platform): string[] | null {
  if ((platform === "win32" ? CMD_METACHARACTERS : SHELL_METACHARACTERS).test(command)) return null;
  const argv = parseCommandArgv(command, platform);
  return argv && argv.length > 0 ? argv : null;
}

/**
 * Opens an external editor with the given initial text, waits for the editor to exit,
 * and returns the resulting text.
 */
export async function openExternalEditor(options: ExternalEditorOptions = {}): Promise<ExternalEditorResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const command = resolveEditorCommand(options);
  const initialText = options.initialText ?? "";

  const tempDir = join(tmpdir(), "tau-editor");
  await mkdir(tempDir, { recursive: true });

  const randomId = randomBytes(6).toString("hex");
  const tempFile = join(tempDir, `prompt-${randomId}.md`);
  const doneFile = join(tempDir, `prompt-${randomId}.done`);

  await writeFile(tempFile, initialText, "utf8");

  try {
    const isCli = isTerminalEditor(command, platform);

    if (isCli && platform === "darwin") {
      // On macOS, if it's a CLI editor, launch Terminal.app running the editor
      const argv = editorCommandArgv(command);
      const scriptPath = join(tempDir, `run-${randomId}.sh`);
      const scriptContent = [
        "#!/bin/sh",
        argv ? `${JSON.stringify(argv[0])} ${argv.slice(1).map((a) => JSON.stringify(a)).join(" ")} "${tempFile}"`.trim() : `${command} "${tempFile}"`,
        `touch "${doneFile}"`,
        "exit 0",
      ].join("\n");

      await writeFile(scriptPath, scriptContent, { mode: 0o755 });

      await new Promise<void>((resolve, reject) => {
        const child = spawn("open", ["-W", "-a", "Terminal", scriptPath], {
          env,
          stdio: "ignore",
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Terminal exited with code ${code}`));
        });
      });

      let waited = 0;
      while (!existsSync(doneFile) && waited < 50) {
        await new Promise((r) => setTimeout(r, 100));
        waited++;
      }
      try { await unlink(scriptPath); } catch {}
      try { await unlink(doneFile); } catch {}
    } else {
      // Spawn directly (GUI editor with --wait or standard editor process)
      const argv = editorCommandArgv(command, platform);
      await new Promise<void>((resolve, reject) => {
        // `code --wait` is `code.cmd` on Windows, which starts only through cmd.exe.
        const invocation = argv ? commandInvocation(argv[0]!, [...argv.slice(1), tempFile], { platform, env }) : undefined;
        const child = invocation
          ? spawn(invocation.command, invocation.args, { env, stdio: "inherit", windowsVerbatimArguments: invocation.windowsVerbatimArguments, windowsHide: invocation.windowsVerbatimArguments === true })
          : spawn(command, [platform === "win32" ? `"${tempFile}"` : tempFile], { shell: true, env, stdio: "inherit" });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Editor exited with code ${code}`));
        });
      });
    }

    const newText = await readFile(tempFile, "utf8");
    const modified = newText !== initialText;

    return { text: newText, modified };
  } finally {
    try {
      if (existsSync(tempFile)) await unlink(tempFile);
    } catch {}
  }
}
