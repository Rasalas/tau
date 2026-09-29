// A second machine for the shots that show one: "studio", a headless Tau host
// on loopback with its own home, userData, token and Pi threads under the run
// folder. The window pairs with it the way a user would (Settings → Machines),
// and the runner approves the request with studio's own token.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { assertEnvUnder } from "../compare/isolation.mjs";
import { parseHostOutput, testHostEnv } from "../tau-test-host.mjs";
import { hostCall } from "../tau-mobile-cdp.mjs";

const MIN = 60_000;
const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** studio's environment: `base` plus every data path under `<root>/studio`, listening on loopback only. */
export function studioEnv({ root, tauRoot, base }) {
  const dir = join(root, "studio");
  const env = { ...testHostEnv({ base, root: tauRoot, dir, machineName: "studio", workspace: join(dir, "home", "code", "nightly-jobs") }), CFFIXED_USER_HOME: join(dir, "home") };
  // A clone root is only for the remote-work tests; nothing here clones.
  delete env.TAU_TEST_CLONE_ROOT;
  assertEnvUnder(env, ["HOME", "TAU_USER_DATA", "TAU_WORKSPACE", "TAU_HOST_TOKEN_FILE", "TAU_CONFIG_FILE", "TAU_WORKTREES_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "CODEX_HOME"], dir);
  return { dir, env };
}

/** A project and two Pi threads on studio, on providers routed to the fake model. */
function writeStudioFixture(env, { baseUrl, now }) {
  for (const path of [env.HOME, env.TAU_USER_DATA, env.CODEX_HOME, env.TAU_OPENCODE_HOME, env.TAU_CURSOR_HOME, env.TAU_GROK_HOME, env.PI_CODING_AGENT_DIR, env.PI_CODING_AGENT_SESSION_DIR, env.TAU_WORKSPACE]) mkdirSync(path, { recursive: true });
  const repo = env.TAU_WORKSPACE;
  writeFileSync(join(repo, "README.md"), "# nightly-jobs\n\nThe jobs the build server runs at night.\n");
  const git = (args) => execFileSync("git", ["-c", "user.name=Sample", "-c", "user.email=sample@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "Initial commit"]);
  const provider = "openai-codex";
  const model = "gpt-5.6-sol";
  writeFileSync(join(env.PI_CODING_AGENT_DIR, "models.json"), `${JSON.stringify({ providers: { [provider]: { baseUrl, apiKey: "sample" } } }, null, 2)}\n`);
  writeFileSync(join(env.PI_CODING_AGENT_DIR, "settings.json"), `${JSON.stringify({ defaultProvider: provider, defaultModel: model }, null, 2)}\n`);
  const thread = (name, user, reply, start) => {
    const id = randomUUID();
    let clock = start;
    const stamp = () => new Date(clock += 20_000).toISOString();
    const lines = [{ type: "session", version: 3, id, timestamp: stamp(), cwd: repo }];
    let parent = null;
    const push = (entry) => { const entryId = randomUUID().slice(0, 8); lines.push({ id: entryId, parentId: parent, timestamp: stamp(), ...entry }); parent = entryId; };
    push({ type: "model_change", provider, modelId: model });
    push({ type: "message", message: { role: "user", content: [{ type: "text", text: user }], timestamp: clock } });
    push({ type: "message", message: { role: "assistant", provider, model, content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: clock } });
    push({ type: "session_info", name });
    const file = join(env.PI_CODING_AGENT_SESSION_DIR, `${new Date(start).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    // The list dates a thread by its file.
    utimesSync(file, new Date(clock), new Date(clock));
  };
  thread("Run the full test matrix", "Run the full test matrix on Node 22 and 24.", "All 1,284 tests pass on both.", now - 12 * MIN);
  thread("Rebuild the search index", "Rebuild the search index from last night's export.", "Rebuilt: 48,210 documents, 3 min 40 s.", now - 70 * MIN);
}

/** Starts studio and resolves once it listens: `{ pid, url, link, token }`. */
export async function startStudio({ root, tauRoot, base, baseUrl, now = Date.now() }) {
  const { dir, env } = studioEnv({ root, tauRoot, base });
  writeStudioFixture(env, { baseUrl, now });
  const logPath = join(root, "logs", "studio.log");
  const log = openSync(logPath, "a");
  const child = spawn(process.execPath, [join(tauRoot, "dist-electron", "main", "headless.js")], { cwd: tauRoot, env, stdio: ["ignore", log, log] });
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && child.exitCode === null;) {
    const printed = parseHostOutput(readFileSync(logPath, "utf8"));
    if (printed?.link) return { pid: child.pid, dir, url: printed.url, link: printed.link, token: readFileSync(env.TAU_HOST_TOKEN_FILE, "utf8").trim() };
    await wait(250);
  }
  if (child.exitCode === null) child.kill("SIGTERM");
  throw new Error(`studio did not start; see ${logPath}`);
}

/** Adds studio in Settings → Machines, allows it there with its own token, and waits until it is connected. */
export async function pairStudio(ctx, studio) {
  const byText = (text) => `[...document.querySelectorAll("button, a")].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
  await ctx.click(`[...document.querySelectorAll("button[aria-label]")].find((button) => button.getAttribute("aria-label") === "Settings")`);
  await ctx.click(byText("Remote"));
  await ctx.click(byText("Machines"));
  await ctx.click(`document.querySelector('input[placeholder*="#pair="]')`);
  await ctx.insertText(studio.link);
  await ctx.click(byText("Add machine"));
  let request;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && !request;) {
    await wait(300);
    request = (await hostCall({ url: studio.url, token: studio.token, method: "connections-list" })).requests[0];
  }
  if (!request) throw new Error("studio got no pairing request");
  const shown = await ctx.evaluate(`document.body.textContent.replace(/\\s/g, "")`);
  if (!shown.includes(String(request.verification).replace(/\D/g, ""))) throw new Error("the window and studio show different codes");
  await hostCall({ url: studio.url, token: studio.token, method: "connections-approve", params: [request.id, {}] });
  await ctx.waitFor(`/studio\\s*[\\s\\S]{0,80}Connected/.test(document.body.textContent)`, 30_000);
  await ctx.click(`[...document.querySelectorAll("button")].find((button) => /^Back to thread/.test(button.textContent.trim()))`);
  await ctx.waitFor(`[...document.querySelectorAll(".thread-title")].some((title) => title.textContent.trim() === "Run the full test matrix")`, 30_000);
}
