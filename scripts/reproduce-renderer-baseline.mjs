import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, symlinkSync } from "node:fs";
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
run("git", ["worktree", "add", "--detach", worktree, subject]);
try {
  run("git", ["apply", patchFile], worktree);
  const dependencies = join(worktree, "node_modules");
  if (!existsSync(dependencies)) symlinkSync(nodeModules, dependencies, "dir");
  run("npm", ["run", "build"], worktree);
  const subjectCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  run("node", ["scripts/renderer-benchmark.mjs", "--no-build", outputFile], worktree, {
    ...process.env,
    TAU_BENCHMARK_SUBJECT_COMMIT: subjectCommit,
    TAU_BENCHMARK_HARNESS_COMMIT: process.env.TAU_BENCHMARK_HARNESS_COMMIT ?? "unknown",
    TAU_BENCHMARK_HARNESS_PATCH_FILE: "reports/renderer-baseline-6ddb454-harness.patch",
    TAU_BENCHMARK_HARNESS_PATCH_SHA256: process.env.TAU_BENCHMARK_HARNESS_PATCH_SHA256 ?? "unknown",
  });
} finally {
  run("git", ["worktree", "remove", "--force", worktree]);
}
