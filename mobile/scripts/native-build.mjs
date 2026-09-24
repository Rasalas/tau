#!/usr/bin/env node
// Builds the app for a simulator or emulator, never signed for a device:
//
//   node scripts/native-build.mjs ios [--dev]       → .build/ios/…/App.app (iOS Simulator)
//   node scripts/native-build.mjs android [--dev]   → android/app/build/outputs/apk/debug/app-debug.apk
//
// `--dev` builds the web layer with the automation bridge (scripts/sim.mjs).
// A TestFlight build is made in Xcode with the user's own team: docs/mobile-testflight.md.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const [platform, ...flags] = process.argv.slice(2);
const dev = flags.includes("--dev");

function run(command, args, options = {}) {
  console.log(`[build] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: here, stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (platform !== "ios" && platform !== "android") {
  console.error("usage: native-build.mjs ios|android [--dev]");
  process.exit(2);
}

run("npx", ["vite", "build", ...(dev ? ["--mode", "development"] : [])]);
run("npx", ["cap", "sync", platform]);

if (platform === "ios") {
  run("xcodebuild", [
    "-project", "ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Debug",
    "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
    "-derivedDataPath", ".build/ios", "build",
  ]);
  console.log(`[build] ${here}.build/ios/Build/Products/Debug-iphonesimulator/App.app`);
} else {
  const gradle = existsSync(`${here}android/gradlew`) ? "./gradlew" : "gradle";
  run(gradle, ["assembleDebug"], { cwd: `${here}android` });
  console.log(`[build] ${here}android/app/build/outputs/apk/debug/app-debug.apk`);
}
