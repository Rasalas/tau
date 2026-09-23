#!/usr/bin/env node
// A stand-in for the CLI the Agent SDK runtime drives, for its login only:
// `--version`, `auth status [--json|--text]`, `auth login [--claudeai|--console]`
// and `auth logout`, in the shapes the real CLI (2.1.280) prints. The login is
// a file in CLAUDE_CONFIG_DIR (or STUB_CLI_HOME); nothing reaches a network.
// STUB_CLI_LOG names a file every call is appended to.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const home = process.env.CLAUDE_CONFIG_DIR ?? process.env.STUB_CLI_HOME ?? join(process.cwd(), ".stub-cli");
const file = join(home, "stub-login.json");
if (process.env.STUB_CLI_LOG) appendFileSync(process.env.STUB_CLI_LOG, `${JSON.stringify(args)}\n`);

function status() {
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  if (stored) return { loggedIn: true, apiProvider: "firstParty", ...stored, configDirectory: home };
  if (process.env.ANTHROPIC_API_KEY) return { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", configDirectory: home, apiKeySource: "ANTHROPIC_API_KEY" };
  return { loggedIn: false, authMethod: "none", apiProvider: "firstParty", configDirectory: home };
}

if (args[0] === "--version") {
  process.stdout.write("2.1.280 (Claude Code)\n");
} else if (args[0] === "auth" && args[1] === "status") {
  const now = status();
  process.stdout.write(args.includes("--text") ? (now.loggedIn ? `Logged in as ${now.email ?? now.authMethod}\n` : "Not logged in. Run claude auth login to authenticate.\n") : `${JSON.stringify(now, null, 2)}\n`);
  process.exitCode = now.loggedIn ? 0 : 1;
} else if (args[0] === "auth" && args[1] === "login") {
  mkdirSync(home, { recursive: true });
  const login = args.includes("--console")
    ? { authMethod: "api_key", apiKeySource: "/login managed key", email: "stub@example.com", orgName: "Stub Org" }
    : { authMethod: "claude.ai", email: "stub@example.com", orgName: "Stub Org", subscriptionType: "max" };
  process.stdout.write("Opening the sign-in page… (stub: signed in at once)\n");
  writeFileSync(file, JSON.stringify(login));
  process.stdout.write("Login successful.\n");
} else if (args[0] === "auth" && args[1] === "logout") {
  rmSync(file, { force: true });
  process.stdout.write("Successfully logged out from your Anthropic account.\n");
} else {
  process.stderr.write(`stub-cli: ${args.join(" ")} is not stubbed\n`);
  process.exitCode = 2;
}
