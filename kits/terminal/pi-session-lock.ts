import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * `pi` typed in Tau's terminal loads the host's Pi extension that holds the
 * session lock (`pi -e $TAU_PI_SESSION_LOCK_EXTENSION …`), so a Pi CLI there
 * does not open a session a Tau host writes, and a Tau host sees the session
 * Pi has open. Pi reads no extension path from the environment, so the shell
 * gets a `pi` function the way terminals add their shell integration: nothing
 * of the user's shell setup or Pi installation is touched.
 */

/** Set by the host for every process it starts; names the compiled extension. */
export const PI_SESSION_LOCK_ENV = "TAU_PI_SESSION_LOCK_EXTENSION";
/** The user's own ZDOTDIR while zsh reads Tau's first startup file. */
const USER_ZDOTDIR = "TAU_USER_ZDOTDIR";
/** Pi's commands that open no session, and whose parser would not take `-e`. */
const PI_SUBCOMMANDS = ["auth", "install", "uninstall", "remove", "update", "list", "config"];

const POSIX_BODY = `{
  if [ -z "\${${PI_SESSION_LOCK_ENV}-}" ] || [ ! -r "\${${PI_SESSION_LOCK_ENV}}" ]; then command pi "$@"; return; fi
  case "\${1-}" in
    ${PI_SUBCOMMANDS.join("|")}) command pi "$@" ;;
    *) command pi -e "\${${PI_SESSION_LOCK_ENV}}" "$@" ;;
  esac
}`;

/** Read by zsh first; hands every later startup file back to the user's own, then defines \`pi\` at the first prompt. */
export const ZSHENV = `# Tau's terminal (Terminal Kit). Generated; changes are overwritten.
if [[ -n "\${${USER_ZDOTDIR}+x}" ]]; then ZDOTDIR="\${${USER_ZDOTDIR}}"; else unset ZDOTDIR; fi
unset ${USER_ZDOTDIR}
if [[ -r "\${ZDOTDIR:-$HOME}/.zshenv" ]]; then source "\${ZDOTDIR:-$HOME}/.zshenv"; fi
if [[ -o interactive ]]; then
  autoload -Uz add-zsh-hook
  __tau_pi_session_lock() {
    add-zsh-hook -d precmd __tau_pi_session_lock
    unfunction __tau_pi_session_lock
    # The user's own pi alias or function wins.
    (( \${+aliases[pi]} || \${+functions[pi]} )) && return 0
    pi() ${POSIX_BODY}
  }
  add-zsh-hook precmd __tau_pi_session_lock
fi
`;

/** Autoloaded by fish from \`$XDG_DATA_DIRS/fish/vendor_functions.d\`; the user's own functions come first. */
export const FISH_FUNCTION = `# Tau's terminal (Terminal Kit). Generated; changes are overwritten.
function pi --description 'Pi, holding the session lock Tau hosts use'
    if not set -q ${PI_SESSION_LOCK_ENV}; or not test -r "$${PI_SESSION_LOCK_ENV}"; or contains -- "$argv[1]" ${PI_SUBCOMMANDS.join(" ")}
        command pi $argv
    else
        command pi -e "$${PI_SESSION_LOCK_ENV}" $argv
    end
end
`;

/** Bash imports an exported function from \`BASH_FUNC_<name>%%\`; rc files that define their own \`pi\` still win. */
export const BASH_FUNCTION = `() ${POSIX_BODY}`;

const FILES: ReadonlyArray<[string, string]> = [
  ["zsh/.zshenv", ZSHENV],
  ["xdg/fish/vendor_functions.d/pi.fish", FISH_FUNCTION],
];

/** Writes the startup files under `dir` where they differ; answers false when they cannot be written. */
export function writePiShellIntegration(dir: string): boolean {
  try {
    for (const [name, text] of FILES) {
      const path = join(dir, name);
      let current: string | undefined;
      try { current = readFileSync(path, "utf8"); } catch { current = undefined; }
      if (current === text) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, { mode: 0o644 });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * What a shell's environment gets so its `pi` loads the extension: nothing
 * when the host names no extension, and nothing for a shell without a way in
 * (sh, PowerShell, cmd), where `pi` stays the user's.
 */
export function piShellEnvironment(
  shell: string,
  env: NodeJS.ProcessEnv,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (!env[PI_SESSION_LOCK_ENV] || platform === "win32") return {};
  const name = basename(shell).replace(/^-/u, "");
  if (name === "zsh") {
    return { ZDOTDIR: join(dir, "zsh"), ...(env.ZDOTDIR !== undefined ? { [USER_ZDOTDIR]: env.ZDOTDIR } : {}) };
  }
  if (name === "bash") return { "BASH_FUNC_pi%%": BASH_FUNCTION };
  if (name === "fish") {
    // Unset means the XDG default, which the prefix must not drop.
    return { XDG_DATA_DIRS: `${join(dir, "xdg")}:${env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"}` };
  }
  return {};
}
