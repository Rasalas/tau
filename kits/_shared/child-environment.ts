/** A visible child must not inherit the host's Electron execution mode. */
export function childEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete result[key];
  }
  return result;
}

/** Multiplexer identities belong to the launching pane, not a new terminal. */
export function terminalEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result = childEnvironment(env);
  for (const key of ["TMUX", "TMUX_PANE", "STY", "WINDOW", "ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"]) delete result[key];
  return Object.fromEntries(Object.entries(result).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
