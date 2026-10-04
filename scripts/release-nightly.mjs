#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const usage = `Usage: npm run release:nightly -- [--help | --dry-run]

Publish remote Rasalas/tau main as a nightly for desktop, iOS TestFlight
and Android Google Play internal testing. Requires an authenticated GitHub CLI.
No local build or version change. The command starts the workflow; it does not
wait for the build or uploads to finish.
`;
const dispatchArgs = ["workflow", "run", "release.yml", "--repo", "Rasalas/tau", "--ref", "main", "-f", "nightly=true"];

if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
} else if (args.length === 1 && args[0] === "--dry-run") {
  console.log(`gh ${dispatchArgs.join(" ")}`);
} else if (args.length > 0) {
  console.error(usage);
  process.exitCode = 2;
} else {
  console.log("Starting a nightly from remote Rasalas/tau main for desktop, TestFlight and Google Play internal testing.");
  const result = spawnSync("gh", dispatchArgs, { stdio: "inherit" });
  if (result.error) {
    console.error(`Could not start GitHub CLI: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
    if (result.status === 0) {
      console.log("Workflow dispatched. Follow the build and uploads at https://github.com/Rasalas/tau/actions/workflows/release.yml");
    }
  }
}
