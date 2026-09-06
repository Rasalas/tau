// End to end for the package installer, without Electron: keygen, sign,
// install a local folder and a git source into a temp home, list them, then
// tamper with a signed file and watch the scan refuse it.
// Needs `npm run build` first (the host modules are imported from dist-electron).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist-electron", "main");
if (!existsSync(join(DIST, "extension-installer.js"))) {
  console.error("✗ dist-electron is missing; run npm run build first.");
  process.exit(1);
}

const guard = setTimeout(() => {
  console.error("✗ the smoke ran into its 120s guard");
  process.exit(1);
}, 120_000);
guard.unref();

const step = (name, detail = "") => console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const { installExtensionSource, listExtensionSources, removeExtensionSource } = await import(pathToFileURL(join(DIST, "extension-installer.js")).href);
const { listExtensionPackages, loadHostExtensionPackages } = await import(pathToFileURL(join(DIST, "extension-packages.js")).href);
const { describeSignature } = await import(pathToFileURL(join(DIST, "extension-signature.js")).href);
const { grantPackage } = await import(pathToFileURL(join(DIST, "extension-grants.js")).href);
const { HostExtensionRegistry } = await import(pathToFileURL(join(DIST, "host-extensions.js")).href);

const scratch = [];
const temp = async (prefix) => {
  const dir = await mkdtemp(join(tmpdir(), `tau-smoke-${prefix}-`));
  scratch.push(dir);
  return dir;
};

const home = await temp("home");
const project = await temp("project");
const keys = await temp("keys");
const userData = join(home, "user-data");
await mkdir(userData, { recursive: true });
process.env.TAU_USER_DATA = userData;
// This smoke never lists Pi sessions today, but it does load real host
// modules in-process; pin the same override dev-instance.mjs and the
// remote-host smoke use so a future session-touching path stays isolated
// under this temp home instead of the real ~/.pi/agent/sessions.
process.env.PI_CODING_AGENT_SESSION_DIR = join(home, "pi-sessions");

async function writePackage(root, id, name) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tau-extension.json"), `${JSON.stringify({ id, name, version: "1.0.0", permissions: ["workspace:read"], host: "./host.ts" }, null, 2)}\n`);
  // The host half answers two commands, so the smoke can run it in its worker:
  // one inside its grant, one that dials out without asking for "network".
  await writeFile(join(dir, "host.ts"), `export default {
  activate(context) {
    context.registerCommand("ping", async (input) => ({ pong: input.n * 2, cwd: await context.services.cwd() }));
    context.registerCommand("dial", async () => (await fetch("http://127.0.0.1:1/")).status);
  },
};
`);
  return dir;
}

const node = (script, args) => execFileSync(process.execPath, [join(ROOT, "scripts", script), ...args], { cwd: ROOT, encoding: "utf8" });

// 1. A publisher key, and a package signed with it.
node("keygen-extension.mjs", ["acme", keys]);
const source = await writePackage(await temp("src"), "acme.hello", "hello");
node("sign-extension.mjs", [source, join(keys, "acme.private.pem"), "acme"]);
if (!existsSync(join(source, "tau-extension.sig"))) fail("sign-extension.mjs wrote no signature");
step("keygen and sign", "acme.hello signed with a fresh Ed25519 key");

// 2. Trust that publisher in the temp home.
const publishers = join(home, ".tau", "trusted-publishers.json");
await mkdir(join(home, ".tau"), { recursive: true });
await writeFile(publishers, `${JSON.stringify({
  version: 1,
  publishers: [{ id: "acme", name: "ACME", key: await readFile(join(keys, "acme.public.pem"), "utf8") }],
}, null, 2)}\n`);

// 3. Install the folder, globally.
const options = { cwd: project, home, publishersFilePath: publishers };
const installed = await installExtensionSource(source, "global", options);
if (installed.id !== "acme.hello") fail(`install answered with ${installed.id}`);
if (installed.signature.state !== "signed") fail(`install called the package ${describeSignature(installed.signature)}`);
step("install from a local folder", `${installed.id} · ${describeSignature(installed.signature)}`);

// 4. A git source, with a stand-in for git so the smoke stays offline.
const bin = await temp("bin");
const origin = await writePackage(await temp("origin"), "acme.remote", "remote");
const shim = join(bin, "git");
await writeFile(shim, `#!/bin/sh\ncp -R "${origin}" "$6"\n`, "utf8");
await chmod(shim, 0o755);
const cloned = await installExtensionSource("git:https://example.com/acme/remote.git", "project", {
  ...options,
  findCommand: (name) => (name === "git" ? shim : undefined),
});
if (!cloned.directory.startsWith(join(home, ".tau", "git"))) fail(`the clone landed in ${cloned.directory}`);
step("install from a git source", `${cloned.id} in ${cloned.directory} (git itself is stubbed offline)`);

// 5. npm needs the network, so it only runs when asked for.
if (process.env.TAU_SMOKE_NPM === "1") {
  const npmSource = process.env.TAU_SMOKE_NPM_PACKAGE ?? "npm:@earendil-works/pi-coding-agent";
  await installExtensionSource(npmSource, "global", options).catch((error) => fail(`npm install failed: ${error.message}`));
  step("install from npm", npmSource);
} else {
  step("install from npm", "skipped (set TAU_SMOKE_NPM=1 to run it against the network)");
}

// 6. list shows both, with the signature state.
const listed = await listExtensionSources(options);
const lines = listed.map((entry) => `${entry.id ?? entry.source} · ${entry.scope} · ${describeSignature(entry.signature)}`);
if (!lines.some((line) => line.includes("signed by ACME"))) fail(`list did not report the signature: ${lines.join(" | ")}`);
step("list", lines.join(" | "));

// 7. The scan sees the installed packages, with the source they came from.
const scan = await listExtensionPackages(project, join(home, ".pi", "agent"), { home, trusted: () => true, publishersFilePath: publishers });
if (scan.packages.length !== 2) fail(`the scan found ${scan.packages.length} packages, not 2: ${JSON.stringify(scan.errors)}`);
step("scan", scan.packages.map((pkg) => `${pkg.manifest.id} from ${pkg.installedFrom}`).join(" | "));

// 8. The signed package runs its host half in a worker and answers a command.
const grantsFilePath = join(home, ".tau", "extension-grants.json");
await grantPackage({ id: "acme.hello", version: "1.0.0", permissions: ["workspace:read"] }, true, grantsFilePath);
const loaded = await loadHostExtensionPackages(project, join(home, ".pi", "agent"), {
  home,
  trusted: () => true,
  publishersFilePath: publishers,
  cacheDir: join(userData, "host-extensions"),
  grantsFilePath,
});
const isolated = loaded.extensions.find((entry) => entry.extension.id === "acme.hello");
if (!isolated) fail(`the approved package did not load: ${JSON.stringify(loaded.errors)}`);
if (isolated.extension.isolation !== "worker") fail(`the package runs ${isolated.extension.isolation}, not in a worker`);
const logs = [];
const registry = new HostExtensionRegistry(
  { cwd: () => project, safeMode: false, log: (label, detail) => logs.push(`${label} ${detail ?? ""}`.trim()) },
  () => undefined,
  { commandTimeoutMs: 20_000 },
);
if (!await registry.activate(isolated.extension)) fail(`the worker did not start: ${registry.summaries()[0]?.error}`);
const answer = await registry.invoke("acme.hello", "ping", { n: 21 });
if (answer.pong !== 42 || answer.cwd !== project) fail(`the worker answered ${JSON.stringify(answer)}`);
step("worker isolation", `acme.hello answered ping from its worker (${JSON.stringify(answer)})`);

// 8b. The same package asked for no "network", so its worker has no way out.
const denied = await registry.invoke("acme.hello", "dial").then(
  (status) => fail(`the worker reached the network without the permission (status ${status})`),
  (error) => error.message,
);
if (!denied.includes("lacks permission network")) fail(`dialling out failed for the wrong reason: ${denied}`);
if (!logs.some((line) => line.startsWith("host-extension.denied"))) fail(`the denial was not logged: ${logs.join(" | ")}`);
await registry.dispose();
step("network denied", denied);

// 9. A file that no longer matches its signed hash stops the package loading.
await writeFile(join(source, "host.ts"), "export default { activate() { /* changed after signing */ } };\n");
const tampered = await listExtensionPackages(project, join(home, ".pi", "agent"), { home, trusted: () => true, publishersFilePath: publishers });
if (tampered.packages.some((pkg) => pkg.manifest.id === "acme.hello")) fail("the tampered package still loaded");
const reason = tampered.errors.find((error) => /signed hash/u.test(error.message));
if (!reason) fail(`the scan gave no hash error: ${JSON.stringify(tampered.errors)}`);
step("tamper refused", reason.message);

// 10. Removing forgets the source and deletes what Tau fetched.
await removeExtensionSource(source, "global", options);
const removal = await removeExtensionSource("git:https://example.com/acme/remote.git", "project", options);
if (!removal.deleted) fail("the clone was not deleted");
const remaining = await listExtensionSources(options);
if (remaining.some((entry) => entry.source === source)) fail("remove left the source listed");
step("remove", `${remaining.length} sources left`);

await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
console.log("\nExtension install smoke passed.");
