import type { confirmExtensionGrant } from "./extension-grants.js";

type GrantAsk = Parameters<typeof confirmExtensionGrant>[1];

/**
 * A test instance can answer the grant dialog itself, because CDP cannot click
 * a native one. Both a development build and `TAU_TEST_INSTANCE` (set by
 * `scripts/dev-instance.mjs`) are required; a packaged app ignores the answer.
 */
export function scriptedGrantAnswer(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): "allow" | "deny" | undefined {
  if (isPackaged || env.TAU_TEST_INSTANCE !== "1") return undefined;
  const answer = env.TAU_TEST_GRANT_ANSWER;
  return answer === "allow" || answer === "deny" ? answer : undefined;
}

/** Shows the native dialog, or answers it for a test instance. */
export function nativeGrantAsk(electron: { app: { isPackaged: boolean }; dialog: { showMessageBox(options: Parameters<GrantAsk>[0] & { noLink: boolean }): Promise<{ response: number }> } }, env: NodeJS.ProcessEnv = process.env): GrantAsk {
  const scripted = scriptedGrantAnswer(electron.app.isPackaged, env);
  return async (prompt) => scripted ? { response: scripted === "allow" ? 1 : 0 } : electron.dialog.showMessageBox({ ...prompt, noLink: true });
}
