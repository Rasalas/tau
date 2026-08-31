import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const subject = process.argv[2] ?? "6ddb4541b02410fa8c462dca4b9bb3b9969d5756";
const worktree = resolve(process.argv[3] ?? `/tmp/tau-renderer-baseline-${process.pid}`);
const nodeModules = resolve(process.argv[4] ?? join(ROOT, "node_modules"));
const patchFile = join(ROOT, "reports", "renderer-baseline-6ddb454-harness.patch");
const outputFile = join(ROOT, "reports", "renderer-baseline-6ddb454.json");

function run(command, args, cwd = ROOT, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: "inherit" });
}

if (!existsSync(patchFile)) throw new Error(`missing reproducible harness patch: ${patchFile}`);
if (!existsSync(nodeModules) || !lstatSync(nodeModules).isDirectory()) throw new Error(`provide a prepared node_modules directory as the third argument: ${nodeModules}`);
const harnessCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const harnessPatchSha256 = createHash("sha256").update(await readFile(patchFile)).digest("hex");
run("git", ["worktree", "add", "--detach", worktree, subject]);
try {
  run("git", ["apply", "--unidiff-zero", patchFile], worktree);
  const dependencies = join(worktree, "node_modules");
  if (!existsSync(dependencies)) symlinkSync(nodeModules, dependencies, "dir");
  run("npm", ["run", "build"], worktree);
  const subjectCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  run("node", ["scripts/renderer-benchmark.mjs", "--no-build", outputFile], worktree, {
    ...process.env,
    TAU_BENCHMARK_SUBJECT_COMMIT: subjectCommit,
    TAU_BENCHMARK_HARNESS_COMMIT: harnessCommit,
    TAU_BENCHMARK_HARNESS_PATCH_FILE: "reports/renderer-baseline-6ddb454-harness.patch",
    TAU_BENCHMARK_HARNESS_PATCH_SHA256: harnessPatchSha256,
  });
  const report = JSON.parse(await readFile(outputFile, "utf8"));
  const manifestFiles = report.execution?.harnessFiles;
  if (!Array.isArray(manifestFiles) || manifestFiles.length === 0 || manifestFiles.some((file) => typeof file !== "string" || file.startsWith("/") || file.includes(".."))) {
    throw new Error("baseline report contains an invalid harness file manifest");
  }
  const manifestHashes = Object.fromEntries(manifestFiles.map((file) => [file, createHash("sha256").update(readFileSync(join(worktree, file))).digest("hex")]));
  const expectedSource = createHash("sha256").update(manifestFiles.map((file) => `${file}\0${manifestHashes[file]}`).join("\0")).digest("hex");
  const expectedBundle = createHash("sha256").update(`${expectedSource}\0${harnessPatchSha256}\0${manifestFiles.join("\0")}`).digest("hex");
  const manifestMatches = JSON.stringify(manifestHashes) === JSON.stringify(report.harnessFileSha256);
  if (report.subjectCommit !== subjectCommit || report.harnessCommit !== harnessCommit || report.harnessPatchSha256 !== harnessPatchSha256 || report.harnessSourceSha256 !== expectedSource || !manifestMatches || report.harnessBundleSha256 !== expectedBundle) {
    throw new Error("baseline report provenance does not match the applied harness manifest");
  }
} finally {
  run("git", ["worktree", "remove", "--force", worktree]);
}
