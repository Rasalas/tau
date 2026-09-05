// End to end for the package installer, without Electron: keygen, sign,
// install a local folder and a git source into a temp home, list them, then
// tamper with a signed file and watch the scan refuse it.
// Needs `npm run build` first (the host modules are imported from dist-electron).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

const { installExtensionSource, listExtensionSources, removeExtensionSource } = await import(join(DIST, "extension-installer.js"));
const { listExtensionPackages } = await import(join(DIST, "extension-packages.js"));
const { describeSignature } = await import(join(DIST, "extension-signature.js"));

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

async function writePackage(root, id, name) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tau-extension.json"), `${JSON.stringify({ id, name, version: "1.0.0", permissions: [], host: "./host.ts" }, null, 2)}\n`);
  await writeFile(join(dir, "host.ts"), "export default { activate() {} };\n");
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

// 8. A file that no longer matches its signed hash stops the package loading.
await writeFile(join(source, "host.ts"), "export default { activate() { /* changed after signing */ } };\n");
const tampered = await listExtensionPackages(project, join(home, ".pi", "agent"), { home, trusted: () => true, publishersFilePath: publishers });
if (tampered.packages.some((pkg) => pkg.manifest.id === "acme.hello")) fail("the tampered package still loaded");
const reason = tampered.errors.find((error) => /signed hash/u.test(error.message));
if (!reason) fail(`the scan gave no hash error: ${JSON.stringify(tampered.errors)}`);
step("tamper refused", reason.message);

// 9. Removing forgets the source and deletes what Tau fetched.
await removeExtensionSource(source, "global", options);
const removal = await removeExtensionSource("git:https://example.com/acme/remote.git", "project", options);
if (!removal.deleted) fail("the clone was not deleted");
const remaining = await listExtensionSources(options);
if (remaining.some((entry) => entry.source === source)) fail("remove left the source listed");
step("remove", `${remaining.length} sources left`);

await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
console.log("\nExtension install smoke passed.");
