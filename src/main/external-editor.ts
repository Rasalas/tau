import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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
export function isTerminalEditor(command: string): boolean {
  const binary = command.trim().split(/\s+/)[0];
  const baseName = binary.replace(/^.*[\\/]/, "");
  return CLI_EDITORS.has(baseName);
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
    const isCli = isTerminalEditor(command);

    if (isCli && platform === "darwin") {
      // On macOS, if it's a CLI editor, launch Terminal.app running the editor
      const scriptPath = join(tempDir, `run-${randomId}.sh`);
      const scriptContent = [
        "#!/bin/sh",
        `${command} "${tempFile}"`,
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
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, [tempFile], {
          shell: true,
          env,
          stdio: "inherit",
        });
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
