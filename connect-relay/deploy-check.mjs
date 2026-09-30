import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./deploy-cloud.sh", import.meta.url));
const image = `europe-west3-docker.pkg.dev/tau-push-e3c95/tau-connect/relay@sha256:${"a".repeat(64)}`;

test("deployment preflight leaves the fence alone on an unsupported SDK; a failed rollout restores it", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tau-connect-deploy-"));
  const log = join(folder, "calls");
  try {
    await writeFile(join(folder, "gcloud"), `#!/usr/bin/env bash
printf 'gcloud %s\\n' "$*" >> "$TEST_CALLS"
case "$*" in
  'run deploy --help') if [[ "$TEST_READY_FLAG" == 1 ]]; then echo --readiness-probe; fi ;;
  'run services list'*) echo tau-connect ;;
  'run services describe'*latestReadyRevisionName*) echo tau-connect-old ;;
  'run services describe'*) echo https://tau-connect.example ;;
  'run deploy'*) exit 1 ;;
esac
`, { mode: 0o700 });
    await writeFile(join(folder, "node"), `#!/usr/bin/env bash
printf 'node %s\\n' "$*" >> "$TEST_CALLS"
echo '{"previousRevision":"tau-connect-old"}'
`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${folder}:${process.env.PATH}`, TEST_CALLS: log, TEST_READY_FLAG: "0" };
    await assert.rejects(run("bash", [script, image, "next"], { env }));
    assert.ok(!(await readFile(log, "utf8")).includes("cloud-state.mjs"));
    await writeFile(log, "");
    await assert.rejects(run("bash", [script, image, "next"], { env: { ...env, TEST_READY_FLAG: "1" } }));
    const calls = await readFile(log, "utf8");
    assert.ok(calls.includes("node cloud-state.mjs tau-connect-next"));
    assert.ok(calls.includes("node cloud-state.mjs tau-connect-old"));
    assert.ok(calls.includes("--to-revisions=tau-connect-old=100"));
    assert.ok(calls.indexOf("tau-connect-next") < calls.indexOf("node cloud-state.mjs tau-connect-old"));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
