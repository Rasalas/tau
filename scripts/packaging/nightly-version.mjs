#!/usr/bin/env node
// Prints the version a nightly build carries: the patch after package.json's
// version, then `-nightly.<UTC date>.<run number>`. It sorts after the release
// it builds on and before the next one, and later runs sort after earlier ones.
//
//   node scripts/packaging/nightly-version.mjs --run 42 [--date 2026-09-22]
import { isMain, main, packageVersion } from "./release.mjs";

export function nightlyVersion(base, date, run) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(base);
  if (!match) throw new Error(`package.json's version "${base}" is not a plain release version.`);
  if (!Number.isInteger(run) || run < 1) throw new Error(`The run number must be a positive integer, not ${run}.`);
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}-nightly.${day}.${run}`;
}

export function parseArgs(argv) {
  const options = { run: undefined, date: new Date() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`${arg} needs a value`);
    if (arg === "--run") options.run = Number(value);
    else if (arg === "--date") options.date = new Date(`${value}T00:00:00Z`);
    else throw new Error(`unknown flag ${JSON.stringify(arg)} (known: --run <n>, --date <YYYY-MM-DD>)`);
  }
  if (options.run === undefined) throw new Error("--run <n> is required");
  if (Number.isNaN(options.date.getTime())) throw new Error("--date must be YYYY-MM-DD");
  return options;
}

if (isMain(import.meta.url)) {
  main(() => {
    const options = parseArgs(process.argv.slice(2));
    console.log(nightlyVersion(packageVersion(), options.date, options.run));
  });
}
